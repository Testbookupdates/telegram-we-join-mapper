"use strict";

/**
 * Runtime requirements:
 * - Node.js 18+ (for global fetch)
 * - Google Cloud Run
 */

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =====================================================
   ENVIRONMENT VARIABLES (REQUIRED)
===================================================== */
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  TELEGRAM_WEBHOOK_SECRET,
  WEBENGAGE_LICENSE_CODE,
  WEBENGAGE_API_KEY,
  STORE_API_KEY,
  FIRE_JOIN_EVENT = "true",
  PORT = 8080,
} = process.env;

if (
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHANNEL_ID ||
  !TELEGRAM_WEBHOOK_SECRET ||
  !WEBENGAGE_LICENSE_CODE ||
  !WEBENGAGE_API_KEY ||
  !STORE_API_KEY
) {
  throw new Error("Missing required environment variables");
}

const FIRE_JOIN = FIRE_JOIN_EVENT.toLowerCase() === "true";

/* =====================================================
   FIRESTORE
===================================================== */
const db = new Firestore();

const COL_TXN = "txn_invites";     // docId = transactionId
const COL_INV = "invite_lookup";   // docId = hash(inviteLink)
const COL_ORPHAN = "orphan_joins";

/* =====================================================
   HELPERS
===================================================== */
const nowIso = () => new Date().toISOString();

const unixSeconds = () => Math.floor(Date.now() / 1000);

const hashInvite = (inviteLink) =>
  crypto.createHash("sha256").update(String(inviteLink)).digest("hex");

/* =====================================================
   TELEGRAM API
===================================================== */
async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;

  const payload = {
    chat_id: channelId,
    member_limit: 1,
    expire_date: unixSeconds() + (48 * 60 * 60), // 48h expiry
    name: String(name).slice(0, 255),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || !json.ok || !json.result?.invite_link) {
    throw new Error(`Telegram createChatInviteLink failed`);
  }

  return json.result.invite_link;
}

/* =====================================================
   WEBENGAGE API
===================================================== */
async function fireWebEngageEvent({ userId, eventName, eventData }) {
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${WEBENGAGE_API_KEY}`,
    },
    body: JSON.stringify({
      userId: String(userId),
      eventName,
      eventData,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`WebEngage failed: ${resp.status} ${body}`);
  }
}

/* =====================================================
   HEALTH
===================================================== */
app.get("/healthz", (_, res) => res.status(200).send("ok"));

/* =====================================================
   1) CREATE INVITE (CALLED BY WEBENGAGE JOURNEY)
===================================================== */
app.post("/create-invite", async (req, res) => {
  try {
    if (req.header("x-api-key") !== STORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userId = String(req.body?.userId || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();

    if (!userId || !transactionId) {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }

    const txnRef = db.collection(COL_TXN).doc(transactionId);

    // Idempotency: reuse existing invite
    const existing = await txnRef.get();
    if (existing.exists && existing.data()?.inviteLink) {
      return res.json({
        ok: true,
        inviteLink: existing.data().inviteLink,
        reused: true,
      });
    }

    const inviteLink = await telegramCreateInviteLink(
      TELEGRAM_CHANNEL_ID,
      `TB|txn:${transactionId}|uid:${userId}|${Date.now()}`
    );

    const inviteHash = hashInvite(inviteLink);

    await txnRef.set({
      userId,
      transactionId,
      inviteLink,
      inviteHash,
      createdAt: nowIso(),
      joined: false,
      telegramUserId: "",
      joinedAt: "",
    });

    await db.collection(COL_INV).doc(inviteHash).set({
      inviteHash,
      inviteLink,
      transactionId,
      userId,
      createdAt: nowIso(),
    });

    return res.json({ ok: true, inviteLink, reused: false });
  } catch (e) {
    console.error("create-invite error:", e);
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/* =====================================================
   2) TELEGRAM WEBHOOK
===================================================== */
app.post("/telegram-webhook", async (req, res) => {
  try {
    // --- Security ---
    if (
      req.header("x-telegram-bot-api-secret-token") !==
      TELEGRAM_WEBHOOK_SECRET
    ) {
      return res.status(403).send("Forbidden");
    }

    const body = req.body || {};
    const upd = body.chat_member || body.my_chat_member;
    if (!upd) return res.status(200).send("ignored");

    const chatId = String(upd.chat?.id || "");
    if (chatId !== String(TELEGRAM_CHANNEL_ID)) {
      return res.status(200).send("ignored: other channel");
    }

    const status = upd.new_chat_member?.status;
    const isJoin =
      status === "member" || status === "administrator" || status === "creator";

    if (!isJoin) {
      return res.status(200).send("ignored: not join");
    }

    const inviteLink = upd.invite_link?.invite_link;
    const telegramUserId = String(upd.new_chat_member?.user?.id || "");

    if (!inviteLink || !telegramUserId) {
      return res.status(200).send("ignored: missing data");
    }

    const inviteHash = hashInvite(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(inviteHash).get();

    if (!invSnap.exists) {
      await db.collection(COL_ORPHAN).add({
        inviteLink,
        inviteHash,
        telegramUserId,
        chatId,
        receivedAt: nowIso(),
        reason: "Invite not found",
      });
      return res.status(200).send("ok: orphan stored");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    // EXACTLY-ONCE join processing
    let shouldFire = false;

    await db.runTransaction(async (t) => {
      const snap = await t.get(txnRef);
      if (!snap.exists) return;

      if (snap.data().joined === true) return;

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

    if (shouldFire && FIRE_JOIN) {
      await fireWebEngageEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: {
          transactionId,
          inviteLink,
          telegramUserId,
        },
      });
    }

    return res.status(200).send("ok: join processed");
  } catch (e) {
    console.error("telegram-webhook error:", e);
    return res.status(200).send("ok: error logged");
  }
});

/* =====================================================
   SERVER
===================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
