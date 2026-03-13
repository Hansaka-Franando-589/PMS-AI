const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const P = require('pino');
const express = require('express');
const axios = require('axios');
const path = require('path');
const qrcode = require('qrcode-terminal');

const config = require('./config');
const { sms, downloadMediaMessage } = require('./lib/msg');
const {
  getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson
} = require('./lib/functions');
const { File } = require('megajs');
const { commands, replyHandlers } = require('./command');

const app = express();
const port = process.env.PORT || 8000;

const prefix = '.';
const ownerNumber = [config.BOT_OWNER || '94742053080'];
const credsPath = path.join(__dirname, '/auth_info_baileys/creds.json');

async function ensureSessionFile() {
  if (!fs.existsSync(credsPath)) {
    console.log("🔄 No local session found.");
    if (config.SESSION_ID) {
      console.log("🔄 Attempting to download session from MEGA...");
      const sessdata = config.SESSION_ID;
      try {
        const filer = File.fromURL(`https://mega.nz/file/${sessdata}`);
        filer.download((err, data) => {
          if (err) throw err;
          fs.mkdirSync(path.join(__dirname, '/auth_info_baileys/'), { recursive: true });
          fs.writeFileSync(credsPath, data);
          console.log("✅ Session downloaded and saved. Starting bot...");
          setTimeout(() => connectToWA(), 2000);
        });
      } catch (e) {
        console.error("❌ Failed to download session. Starting with Pairing Code...");
        setTimeout(() => connectToWA(), 1000);
      }
    } else {
      console.log("🔄 No SESSION_ID found. Starting process to generate Pairing Code...");
      setTimeout(() => connectToWA(), 1000);
    }
  } else {
    console.log("✅ Local session found. Starting bot...");
    setTimeout(() => connectToWA(), 1000);
  }
}

async function connectToWA() {
  console.log("Connecting Dexer MD 🧬...");
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '/auth_info_baileys/'));
  const { version } = await fetchLatestBaileysVersion();

  const danuwa = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Firefox"),
    auth: state,
    version,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
  });

  // Pairing Code Logic
  if (!danuwa.authState.creds.registered) {
    const phoneNumber = config.BOT_OWNER.replace(/[^0-9]/g, ''); // Ensure only digits
    setTimeout(async () => {
      try {
        let code = await danuwa.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log(`\n=========================================\n`);
        console.log(`🔑 ඔබේ පේයාරිං කේතය (PAIRING CODE): \x1b[32m${code}\x1b[0m`);
        console.log(`ඔබගේ WhatsApp හි 'Linked Devices' වෙත ගොස් 'Link with Phone Number' හරහා ඉහත කේතය ලබා දෙන්න.`);
        console.log(`\n=========================================\n`);
      } catch (err) {
        console.log("❌ Pairing Code එක ලබා ගැනීමේදී දෝෂයක් ඇතිවිය: ", err);
      }
    }, 3000);
  }

  danuwa.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        connectToWA();
      }
    } else if (connection === 'open') {
      console.log('✅ Dexer MD connected to WhatsApp');
      await danuwa.sendPresenceUpdate('available'); // Always show Online

      // Load plugins first so bot is functional even if the welcome message fails
      try {
        fs.readdirSync("./plugins/").forEach((plugin) => {
          if (path.extname(plugin).toLowerCase() === ".js") {
            require(`./plugins/${plugin}`);
          }
        });
        console.log('✅ Plugins loaded successfully');
      } catch (err) {
        console.error('❌ Failed to load plugins:', err);
      }

      const up = `Dexer MD connected ✅\n\nPREFIX: ${prefix}`;
      try {
        await danuwa.sendMessage(ownerNumber[0] + "@s.whatsapp.net", {
          image: { url: config.ALIVE_IMG || `https://i.ibb.co/WpNDqSrd/freepik-highcontrast-dark-hackerthemed-logo-design-for-a-h-3878.png` },
          caption: up
        });
      } catch (err) {
        console.error('❌ Failed to send startup image message:', err);
        // Fallback to sending just text if image fetch fails
        try {
          await danuwa.sendMessage(ownerNumber[0] + "@s.whatsapp.net", {
            text: up
          });
        } catch (e) {
          console.error('❌ Failed to send fallback startup message:', e);
        }
      }
    }
  });

  danuwa.ev.on('creds.update', saveCreds);

  danuwa.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.messageStubType === 68) {
        await danuwa.sendMessageAck(msg.key);
      }
    }

    const mek = messages[0];
    if (!mek || !mek.message) return;

    // Send read receipt (Blue Ticks)
    await danuwa.readMessages([mek.key]);

    // Send typing indicator immediately when a message is received
    await danuwa.sendPresenceUpdate('composing', mek.key.remoteJid);

    mek.message = getContentType(mek.message) === 'ephemeralMessage' ? mek.message.ephemeralMessage.message : mek.message;
    if (mek.key.remoteJid === 'status@broadcast') return;

    const m = sms(danuwa, mek);
    const type = getContentType(mek.message);
    const from = mek.key.remoteJid;
    const body = type === 'conversation' ? mek.message.conversation : mek.message[type]?.text || mek.message[type]?.caption || '';
    const isCmd = body.startsWith(prefix);
    const commandName = isCmd ? body.slice(prefix.length).trim().split(" ")[0].toLowerCase() : '';
    const args = body.trim().split(/ +/).slice(1);
    const q = args.join(' ');

    const sender = mek.key.fromMe ? danuwa.user.id : (mek.key.participant || mek.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const isGroup = from.endsWith('@g.us');
    const botNumber = danuwa.user.id.split(':')[0];
    const pushname = mek.pushName || 'Sin Nombre';
    const isMe = botNumber.includes(senderNumber);
    const isOwner = ownerNumber.includes(senderNumber) || isMe;
    const botNumber2 = await jidNormalizedUser(danuwa.user.id);

    const groupMetadata = isGroup ? await danuwa.groupMetadata(from).catch(() => { }) : '';
    const groupName = isGroup ? groupMetadata.subject : '';
    const participants = isGroup ? groupMetadata.participants : '';
    const groupAdmins = isGroup ? await getGroupAdmins(participants) : '';
    const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false;
    const isAdmins = isGroup ? groupAdmins.includes(sender) : false;

    const reply = (text) => danuwa.sendMessage(from, { text }, { quoted: mek });

    if (isCmd) {
      const cmd = commands.find((c) => c.pattern === commandName || (c.alias && c.alias.includes(commandName)));
      if (cmd) {
        if (cmd.react) danuwa.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
        try {
          cmd.function(danuwa, mek, m, {
            from, quoted: mek, body, isCmd, command: commandName, args, q,
            isGroup, sender, senderNumber, botNumber2, botNumber, pushname,
            isMe, isOwner, groupMetadata, groupName, participants, groupAdmins,
            isBotAdmins, isAdmins, reply,
          });
        } catch (e) {
          console.error("[PLUGIN ERROR]", e);
        }
      }
    }

    const replyText = body;
    for (const handler of replyHandlers) {
      if (handler.filter(replyText, { sender, message: mek })) {
        try {
          await handler.function(danuwa, mek, m, {
            from, quoted: mek, body: replyText, sender, reply,
          });
          break;
        } catch (e) {
          console.log("Reply handler error:", e);
        }
      }
    }
  });
}

ensureSessionFile();

app.get("/", (req, res) => {
  res.send("Hey, Dexer MD started✅");
});

app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
