/* =======================================================
 * Telegram → Firestore → WebEngage Join Mapper
 * Cloud Run | Node.js 18+
 * ======================================================= */

"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

// -------------------------------------------------------
// App setup
// -------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

// -------------------------------------------------------
// Environment variables
// -------------------------------------------------------
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

// -------------------------------------------------------
// Startup validation
// -------------------------------------------------------
console.log("🚀 Starting telegram-we-join-mapper");

[
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "WEBENGAGE_LICENSE_CODE",
  "WEBENGAGE_API_KEY",
  "STORE_API_KEY",
].forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing ENV: ${key}`);
  } else {
    console.log(`✅ ENV loaded: ${key}`);
  }
});

// -------------------------------------------------------
// Firestore
// -------------------------------------------------------
const db = new Firestore();

const COL_TXN = "txn_invites";
const COL_INV = "invite_lookup";
const COL_ORPHAN = "orphan_joins";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
const nowIso = () => new Date().toISOString();

const hashInviteLink = (link) =>
  crypto.createHash("sha256").update(String(link)).digest("hex");

// -------------------------------------------------------
// Telegram API
// -------------------------------------------------------
async function createTelegramInviteLink(channelId, name) {
  console.log("📨 Creating Telegram invite");

  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        member_limit: 1,
        name: name.slice(0, 255),
      }),
    }
  );

  const data = await res.json();

  if (!res.ok || !data.ok || !data.result?.invite_link) {
    console.error("❌ Telegram API error:", data);
    throw new Error("Failed to create Telegram invite");
  }

  return data.result.invite_link;
}

// -------------------------------------------------------
// WebEngage
// -------------------------------------------------------
async function fireWebEngageEvent({ userId, eventName, eventData }) {
  console.log("📊 WebEngage event:", eventName, userId);

  const res = await fetch(
    `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBENGAGE_API_KEY}`,
      },
      body: JSON.stringify({ userId, eventName, eventData }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    console.error("❌ WebEngage error:", errorText);
    throw new Error("WebEngage event failed");
  }
}

// -------------------------------------------------------
// Health checks
// -------------------------------------------------------
app.get("/healthz", (_, res) => res.status(200).send("ok"));

app.get("/telegram-webhook", (_, res) =>
  res.status(200).send("telegram webhook alive")
);

// -------------------------------------------------------
// CREATE INVITE (secured endpoint)
// -------------------------------------------------------
app.post("/create-invite", async (req, res) => {
  console.log("➡️ /create-invite");

  try {
    if (req.header("x-api-key") !== STORE_API_KEY) {
      console.warn("⛔ Unauthorized request");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userId = String(req.body?.userId || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();

    if (!userId || !transactionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing userId or transactionId",
      });
    }

    const txnRef = db.collection(COL_TXN).doc(transactionId);
    const txnSnap = await txnRef.get();

    if (txnSnap.exists && txnSnap.data()?.inviteLink) {
      console.log("♻️ Reusing invite");
      return res.json({
        ok: true,
        inviteLink: txnSnap.data().inviteLink,
        reused: true,
      });
    }

    const inviteName = `txn:${transactionId}|uid:${userId}|${Date.now()}`;
    const inviteLink = await createTelegramInviteLink(
      TELEGRAM_CHANNEL_ID,
      inviteName
    );

    const inviteHash = hashInviteLink(inviteLink);

    await txnRef.set({
      userId,
      transactionId,
      inviteLink,
      inviteHash,
      joined: false,
      createdAt: nowIso(),
    });

    await db.collection(COL_INV).doc(inviteHash).set({
      inviteHash,
      inviteLink,
      transactionId,
      userId,
      createdAt: nowIso(),
    });

    console.log("✅ Invite created & stored");
    res.json({ ok: true, inviteLink, reused: false });
  } catch (err) {
    console.error("❌ create-invite error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------
// TELEGRAM WEBHOOK
// -------------------------------------------------------
app.post("/telegram-webhook", async (req, res) => {
  console.log("📥 Telegram webhook received");

  try {
    const payload =
      req.body?.chat_member ||
      req.body?.my_chat_member ||
      req.body;

    const chatId = String(payload?.chat?.id || "");
    const status = payload?.new_chat_member?.status;
    const telegramUserId = String(payload?.new_chat_member?.user?.id || "");
    const inviteLink = payload?.invite_link?.invite_link;

    if (
      chatId !== TELEGRAM_CHANNEL_ID ||
      !["member", "administrator", "creator"].includes(status)
    ) {
      return res.send("ignored");
    }

    if (!inviteLink || !telegramUserId) {
      return res.send("ignored");
    }

    const inviteHash = hashInviteLink(inviteLink);
    const invRef = db.collection(COL_INV).doc(inviteHash);
    const invSnap = await invRef.get();

    if (!invSnap.exists) {
      console.warn("⚠️ Orphan join detected");
      await db.collection(COL_ORPHAN).add({
        inviteLink,
        telegramUserId,
        receivedAt: nowIso(),
      });
      return res.send("orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;

    await db.runTransaction(async (t) => {
      const snap = await t.get(txnRef);
      if (snap.exists && snap.data().joined) return;

      t.set(
        txnRef,
        {
          joined: true,
          telegramUserId,
          joinedAt: nowIso(),
        },
        { merge: true }
      );

      shouldFire = true;
    });

    if (shouldFire && SHOULD_FIRE_JOIN_EVENT) {
      await fireWebEngageEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, telegramUserId },
      });
    }

    console.log("✅ Join processed");
    res.send("ok");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.send("error logged");
  }
});

// -------------------------------------------------------
// Server start
// -------------------------------------------------------
app.listen(PORT, () =>
  console.log(`🚀 Server listening on port ${PORT}`)
);