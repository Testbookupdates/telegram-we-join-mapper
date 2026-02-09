"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

// Polyfill fetch for Node environments
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============= CONFIGURATION =============
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  WEBENGAGE_LICENSE_CODE,
  WEBENGAGE_API_KEY,
  STORE_API_KEY,
  PORT = 8080,
} = process.env;

const db = new Firestore();

const COL_TXN = "txn_invites";    
const COL_INV = "invite_lookup";  

// ============= HELPERS =============
const getUnixTimeSeconds = () => Math.floor(Date.now() / 1000);
const hashInviteLink = (link) => crypto.createHash("sha256").update(String(link || "")).digest("hex");

// ============= EXTERNAL APIS =============

/**
 * Sends custom events to WebEngage
 */
async function webengageFireEvent({ userId, eventName, eventData }) {
  // Switched back to Global endpoint (where you previously got Status 201)
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE.trim()}/events`;
  
  const payload = {
    userId: String(userId),
    eventName,
    eventTime: getUnixTimeSeconds(),
    eventData
  };

  // DEBUG: Check credentials in logs (only first 4 chars for safety)
  const keySnippet = WEBENGAGE_API_KEY ? WEBENGAGE_API_KEY.trim().substring(0, 4) : "MISSING";
  console.log(`[WE Auth Check] Key: ${keySnippet}*** | User: ${userId} | URL: ${url}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WEBENGAGE_API_KEY.trim()}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    console.log(`[WE Response] Status: ${res.status} | Body: ${body}`);
    return res.ok;
  } catch (err) {
    console.error(`[WE Network Error]: ${err.message}`);
    return false;
  }
}

/**
 * Creates a single-use Telegram invite link
 */
async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      member_limit: 1, 
      expire_date: getUnixTimeSeconds() + (48 * 60 * 60),
      name: String(name || "").slice(0, 255),
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`TG Error: ${JSON.stringify(data)}`);
  return data.result.invite_link;
}

// ============= ENDPOINTS =============

app.get("/healthz", (_, res) => res.status(200).send("ok"));

/**
 * 1. POST /create-invite
 */
app.post("/create-invite", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key");
    if (apiKey !== STORE_API_KEY) return res.status(401).send("Unauthorized");

    const { userId, transactionId } = req.body;
    if (!userId || !transactionId) return res.status(400).send("Missing data");

    const txnRef = db.collection(COL_TXN).doc(transactionId);
    
    // Create Link
    const inviteLink = await telegramCreateInviteLink(TELEGRAM_CHANNEL_ID, `TB|${userId}`);
    const invHash = hashInviteLink(inviteLink);

    // Store in DB
    await db.batch()
      .set(txnRef, { userId, transactionId, inviteLink, inviteHash: invHash, joined: false })
      .set(db.collection(COL_INV).doc(invHash), { transactionId, userId, inviteLink })
      .commit();

    // Fire WebEngage
    await webengageFireEvent({
      userId,
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink }
    });

    res.json({ ok: true, inviteLink });
  } catch (err) {
    console.error(`[Endpoint Error]: ${err.message}`);
    res.status(500).send(err.message);
  }
});

/**
 * 2. POST /telegram-webhook
 */
app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const upd = body.chat_member || body.my_chat_member || body;

    const chatId = String(upd?.chat?.id || "").trim();
    const newStatus = String(upd?.new_chat_member?.status || "").trim();
    const telegramUserId = String(upd?.new_chat_member?.user?.id || "").trim();
    const inviteLink = String(upd?.invite_link?.invite_link || "").trim();

    if (!["member", "administrator", "creator"].includes(newStatus)) return res.send("ignored");
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) return res.send("wrong channel");
    if (!inviteLink) return res.send("no link");

    const invHash = hashInviteLink(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(invHash).get();

    if (!invSnap.exists) return res.send("link not found");

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;
    await db.runTransaction(async (t) => {
      const snap = await t.get(txnRef);
      if (!snap.exists || snap.data().joined) return;
      t.update(txnRef, { joined: true, telegramUserId, joinedAt: new Date().toISOString() });
      shouldFire = true;
    });

    if (shouldFire) {
      await webengageFireEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink, telegramUserId },
      });
    }

    res.send("ok");
  } catch (err) {
    console.error(`[Webhook Error]: ${err.message}`);
    res.status(200).send("logged");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bridge Online on port ${PORT}`);
});
