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
  FIRE_JOIN_EVENT = "true",
  PORT = 8080,
} = process.env;

const SHOULD_FIRE_JOIN_EVENT = FIRE_JOIN_EVENT.toLowerCase() === "true";

const db = new Firestore();

// Firestore Collection Names
const COL_TXN = "txn_invites";    
const COL_INV = "invite_lookup";  
const COL_ORPHAN = "orphan_joins"; 

// ============= HELPERS =============
const nowIso = () => new Date().toISOString();
const getUnixTimeSeconds = () => Math.floor(Date.now() / 1000);

function hashInviteLink(inviteLink) {
  return crypto.createHash("sha256").update(String(inviteLink || "")).digest("hex");
}

// ============= EXTERNAL APIS =============

/**
 * Sends custom events to WebEngage (India Region Endpoint)
 */
async function webengageFireEvent({ userId, eventName, eventData }) {
  // FIX: Using the .in endpoint for Indian data centers
  const url = `https://api.in.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;
  
  const payload = {
    userId: String(userId),
    eventName,
    eventTime: getUnixTimeSeconds(),
    eventData
  };

  console.log(`[WebEngage Outgoing] Target: .in API | User: ${userId} | Event: ${eventName}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WEBENGAGE_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    console.log(`[WebEngage Response] Status: ${res.status} | Body: ${body}`);
    return res.ok;
  } catch (err) {
    console.error(`[WebEngage Error] ${eventName}: ${err.message}`);
    return false;
  }
}

/**
 * Creates a single-use Telegram invite link
 */
async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  const expireDate = getUnixTimeSeconds() + (48 * 60 * 60);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      member_limit: 1, 
      expire_date: expireDate,
      name: String(name || "").slice(0, 255),
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok || !data.result?.invite_link) {
    throw new Error(`Telegram Error: ${JSON.stringify(data)}`);
  }
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
    if (!apiKey || apiKey !== STORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { userId, transactionId } = req.body;
    if (!userId || !transactionId) {
      return res.status(400).json({ ok: false, error: "Missing userId or transactionId" });
    }

    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const txnSnap = await txnRef.get();
    
    let inviteLink;
    let reused = false;

    if (txnSnap.exists && txnSnap.data()?.inviteLink) {
      inviteLink = txnSnap.data().inviteLink;
      reused = true;
    } else {
      const linkName = `TB|txn:${transactionId}|uid:${userId}`.slice(0, 255);
      inviteLink = await telegramCreateInviteLink(TELEGRAM_CHANNEL_ID, linkName);
      const invHash = hashInviteLink(inviteLink);

      const batch = db.batch();
      batch.set(txnRef, {
        userId, transactionId, inviteLink, inviteHash: invHash,
        createdAt: nowIso(), joined: false
      }, { merge: true });
      
      batch.set(db.collection(COL_INV).doc(invHash), {
        transactionId, userId, inviteLink, createdAt: nowIso(),
      }, { merge: true });

      await batch.commit();
    }

    await webengageFireEvent({
      userId,
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink, reused }
    });

    res.json({ ok: true, inviteLink, reused });
  } catch (err) {
    console.error(`[Error] /create-invite: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
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

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).doc(`${invHash}_${Date.now()}`).set({
        inviteLink, telegramUserId, receivedAt: nowIso(), reason: "Link not found"
      });
      return res.send("orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;
    await db.runTransaction(async (t) => {
      const snap = await t.get(txnRef);
      if (!snap.exists || snap.data().joined) return;
      t.update(txnRef, { joined: true, telegramUserId, joinedAt: nowIso() });
      shouldFire = true;
    });

    if (shouldFire && SHOULD_FIRE_JOIN_EVENT) {
      await webengageFireEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink, telegramUserId },
      });
    }

    res.send("ok");
  } catch (err) {
    console.error(`[Webhook Error] ${err.message}`);
    res.status(200).send("error logged");
  }
});

// Bind to 0.0.0.0 for Cloud Run
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bridge Online on port ${PORT}`);
});
