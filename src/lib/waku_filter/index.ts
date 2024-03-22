import type { Stream } from "@libp2p/interface-connection";
import type { PeerId } from "@libp2p/interface-peer-id";
import type { Peer } from "@libp2p/interface-peer-store";
import type { IncomingStreamData } from "@libp2p/interface-registrar";
import debug from "debug";
import all from "it-all";
import * as lp from "it-length-prefixed";
import { pipe } from "it-pipe";
import type { Libp2p } from "libp2p";

import { WakuMessage as WakuMessageProto } from "../../proto/message";
import { DefaultPubSubTopic } from "../constants";
import { selectConnection } from "../select_connection";
import { getPeersForProtocol, selectRandomPeer } from "../select_peer";
import { hexToBytes } from "../utils";
import { DecryptionMethod, WakuMessage } from "../waku_message";

import { ContentFilter, FilterRPC } from "./filter_rpc";
export { ContentFilter };

export const FilterCodec = "/vac/waku/filter/2.0.0-beta1";

const log = debug("waku:filter");

export interface CreateOptions {
  /**
   * The PubSub Topic to use. Defaults to {@link DefaultPubSubTopic}.
   *
   * The usage of the default pubsub topic is recommended.
   * See [Waku v2 Topic Usage Recommendations](https://rfc.vac.dev/spec/23/) for details.
   *
   * @default {@link DefaultPubSubTopic}
   */
  pubSubTopic?: string;
}

export type FilterSubscriptionOpts = {
  /**
   * The Pubsub topic for the subscription
   */
  pubsubTopic?: string;
  /**
   * Optionally specify a PeerId for the subscription. If not included, will use a random peer.
   */
  peerId?: PeerId;
};

export type FilterCallback = (msg: WakuMessage) => void | Promise<void>;

export type UnsubscribeFunction = () => Promise<void>;

/**
 * Implements client side of the [Waku v2 Filter protocol](https://rfc.vac.dev/spec/12/).
 *
 * Note this currently only works in NodeJS when the Waku node is listening on a port, see:
 * - https://github.com/status-im/go-waku/issues/245
 * - https://github.com/status-im/nwaku/issues/948
 */
export class WakuFilter {
  pubSubTopic: string;
  private subscriptions: Map<string, FilterCallback>;
  public decryptionKeys: Map<
    Uint8Array,
    { method?: DecryptionMethod; contentTopics?: string[] }
  >;

  constructor(public libp2p: Libp2p, options?: CreateOptions) {
    this.subscriptions = new Map();
    this.decryptionKeys = new Map();
    this.pubSubTopic = options?.pubSubTopic ?? DefaultPubSubTopic;
    this.libp2p
      .handle(FilterCodec, this.onRequest.bind(this))
      .catch((e) => log("Failed to register filter protocol", e));
  }

  /**
   * @param contentTopics Array of ContentTopics to subscribe to. If empty, no messages will be returned from the filter.
   * @param callback A function that will be called on each message returned by the filter.
   * @param opts The FilterSubscriptionOpts used to narrow which messages are returned, and which peer to connect to.
   * @returns Unsubscribe function that can be used to end the subscription.
   */
  async subscribe(
    callback: FilterCallback,
    contentTopics: string[],
    opts?: FilterSubscriptionOpts
  ): Promise<UnsubscribeFunction> {
    const topic = opts?.pubsubTopic ?? this.pubSubTopic;
    const contentFilters = contentTopics.map((contentTopic) => ({
      contentTopic,
    }));
    const request = FilterRPC.createRequest(
      topic,
      contentFilters,
      undefined,
      true
    );

    const requestId = request.requestId;
    if (!requestId)
      throw new Error(
        "Internal error: createRequest expected to set `requestId`"
      );

    const peer = await this.getPeer(opts?.peerId);
    const stream = await this.newStream(peer);

    try {
      const res = await pipe(
        [request.encode()],
        lp.encode(),
        stream,
        lp.decode(),
        async (source) => await all(source)
      );

      log("response", res);
    } catch (e) {
      log(
        "Error subscribing to peer ",
        peer.id.toString(),
        "for content topics",
        contentTopics,
        ": ",
        e
      );
      throw e;
    }

    this.addCallback(requestId, callback);

    return async () => {
      await this.unsubscribe(topic, contentFilters, requestId, peer);
      this.removeCallback(requestId);
    };
  }

  private onRequest(streamData: IncomingStreamData): void {
    log("Receiving message push");
    try {
      pipe(streamData.stream, lp.decode(), async (source) => {
        for await (const bytes of source) {
          const res = FilterRPC.decode(bytes.slice());
          if (res.requestId && res.push?.messages?.length) {
            await this.pushMessages(res.requestId, res.push.messages);
          }
        }
      }).then(
        () => {
          log("Receiving pipe closed.");
        },
        (e) => {
          log("Error with receiving pipe", e);
        }
      );
    } catch (e) {
      log("Error decoding message", e);
    }
  }

  private async pushMessages(
    requestId: string,
    messages: WakuMessageProto[]
  ): Promise<void> {
    const callback = this.subscriptions.get(requestId);
    if (!callback) {
      log(`No callback registered for request ID ${requestId}`);
      return;
    }

    const decryptionParams = Array.from(this.decryptionKeys).map(
      ([key, { method, contentTopics }]) => {
        return {
          key,
          method,
          contentTopics,
        };
      }
    );

    for (const message of messages) {
      const decoded = await WakuMessage.decodeProto(message, decryptionParams);
      if (!decoded) {
        log("Not able to decode message");
        continue;
      }
      callback(decoded);
    }
  }

  private addCallback(requestId: string, callback: FilterCallback): void {
    this.subscriptions.set(requestId, callback);
  }

  private removeCallback(requestId: string): void {
    this.subscriptions.delete(requestId);
  }

  private async unsubscribe(
    topic: string,
    contentFilters: ContentFilter[],
    requestId: string,
    peer: Peer
  ): Promise<void> {
    const unsubscribeRequest = FilterRPC.createRequest(
      topic,
      contentFilters,
      requestId,
      false
    );

    const stream = await this.newStream(peer);
    try {
      await pipe([unsubscribeRequest.encode()], lp.encode(), stream.sink);
    } catch (e) {
      log("Error unsubscribing", e);
      throw e;
    }
  }

  private async newStream(peer: Peer): Promise<Stream> {
    const connections = this.libp2p.connectionManager.getConnections(peer.id);
    const connection = selectConnection(connections);
    if (!connection) {
      throw new Error("Failed to get a connection to the peer");
    }

    return connection.newStream(FilterCodec);
  }

  private async getPeer(peerId?: PeerId): Promise<Peer> {
    let peer;
    if (peerId) {
      peer = await this.libp2p.peerStore.get(peerId);
      if (!peer) {
        throw new Error(
          `Failed to retrieve connection details for provided peer in peer store: ${peerId.toString()}`
        );
      }
    } else {
      peer = await this.randomPeer();
      if (!peer) {
        throw new Error(
          "Failed to find known peer that registers waku filter protocol"
        );
      }
    }
    return peer;
  }

  /**
   * Register a decryption key to attempt decryption of messages received in any
   * subsequent { @link subscribe } call. This can either be a private key for
   * asymmetric encryption or a symmetric key. { @link WakuStore } will attempt to
   * decrypt messages using both methods.
   *
   * Strings must be in hex format.
   */
  addDecryptionKey(
    key: Uint8Array | string,
    options?: { method?: DecryptionMethod; contentTopics?: string[] }
  ): void {
    this.decryptionKeys.set(hexToBytes(key), options ?? {});
  }

  /**
   * Delete a decryption key so that it cannot be used in future { @link subscribe } calls
   *
   * Strings must be in hex format.
   */
  deleteDecryptionKey(key: Uint8Array | string): void {
    this.decryptionKeys.delete(hexToBytes(key));
  }

  async peers(): Promise<Peer[]> {
    return getPeersForProtocol(this.libp2p, [FilterCodec]);
  }

  async randomPeer(): Promise<Peer | undefined> {
    return selectRandomPeer(await this.peers());
  }
}
