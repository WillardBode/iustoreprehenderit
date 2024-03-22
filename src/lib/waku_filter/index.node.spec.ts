import { expect } from "chai";
import debug from "debug";

import { makeLogFileName, NOISE_KEY_1, Nwaku } from "../../test_utils";
import { delay } from "../../test_utils/delay";
import { createWaku } from "../create_waku";
import { waitForRemotePeer } from "../wait_for_remote_peer";
import { Protocols, Waku } from "../waku";
import { WakuMessage } from "../waku_message";

const log = debug("waku:test");

const TestContentTopic = "/test/1/waku-filter";

describe("Waku Filter", () => {
  let waku: Waku;
  let nwaku: Nwaku;

  afterEach(async function () {
    !!nwaku && nwaku.stop();
    !!waku && waku.stop().catch((e) => console.log("Waku failed to stop", e));
  });

  beforeEach(async function () {
    this.timeout(15000);
    nwaku = new Nwaku(makeLogFileName(this));
    await nwaku.start({ filter: true, lightpush: true });
    waku = await createWaku({
      staticNoiseKey: NOISE_KEY_1,
      libp2p: { addresses: { listen: ["/ip4/0.0.0.0/tcp/0/ws"] } },
    });
    await waku.start();
    await waku.dial(await nwaku.getMultiaddrWithId());
    await waitForRemotePeer(waku, [Protocols.Filter, Protocols.LightPush]);
  });

  it("creates a subscription", async function () {
    this.timeout(10000);

    let messageCount = 0;
    const messageText = "Filtering works!";
    const callback = (msg: WakuMessage): void => {
      log("Got a message");
      messageCount++;
      expect(msg.contentTopic).to.eq(TestContentTopic);
      expect(msg.payloadAsUtf8).to.eq(messageText);
    };
    await waku.filter.subscribe(callback, [TestContentTopic]);
    // As the filter protocol does not cater for a ack of subscription
    // we cannot know whether the subscription happened. Something we want to
    // correct in future versions of the protocol.
    await delay(200);
    const message = await WakuMessage.fromUtf8String(
      messageText,
      TestContentTopic
    );
    await waku.lightPush.push(message);
    while (messageCount === 0) {
      await delay(250);
    }
    expect(messageCount).to.eq(1);
  });

  it("handles multiple messages", async function () {
    this.timeout(10000);

    let messageCount = 0;
    const callback = (msg: WakuMessage): void => {
      messageCount++;
      expect(msg.contentTopic).to.eq(TestContentTopic);
    };
    await waku.filter.subscribe(callback, [TestContentTopic]);
    await delay(200);
    await waku.lightPush.push(
      await WakuMessage.fromUtf8String("Filtering works!", TestContentTopic)
    );
    await waku.lightPush.push(
      await WakuMessage.fromUtf8String(
        "Filtering still works!",
        TestContentTopic
      )
    );
    while (messageCount < 2) {
      await delay(250);
    }
    expect(messageCount).to.eq(2);
  });

  it("unsubscribes", async function () {
    let messageCount = 0;
    const callback = (): void => {
      messageCount++;
    };
    const unsubscribe = await waku.filter.subscribe(callback, [
      TestContentTopic,
    ]);
    await delay(200);
    await waku.lightPush.push(
      await WakuMessage.fromUtf8String(
        "This should be received",
        TestContentTopic
      )
    );
    await delay(100);
    await unsubscribe();
    await delay(200);
    await waku.lightPush.push(
      await WakuMessage.fromUtf8String(
        "This should not be received",
        TestContentTopic
      )
    );
    await delay(100);
    expect(messageCount).to.eq(1);
  });
});
