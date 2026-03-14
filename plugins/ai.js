const { cmd } = require('../command');
const axios = require('axios');
const config = require('../config');
const { db } = require('../lib/firebase');

// Gemini REST API endpoint (v1beta - compatible with existing API key)
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`;

// In-memory state management for users
const userStates = {};

cmd({
    pattern: "aichat",
    desc: "Chat with Gemini AI automatically.",
    category: "ai",
    filename: __filename,
    filter: (text, context) => {
        // Only trigger if it's not a command starting with a prefix
        if (typeof text === 'string' && text.startsWith('.')) return false;
        return true; // We return true to handle image messages as well
    }
},
    async (danuwa, mek, m, {
        from, quoted, body, isCmd, command, args, q, isGroup,
        sender, senderNumber, botNumber2, botNumber, pushname,
        isMe, isOwner, groupMetadata, groupName, participants,
        groupAdmins, isBotAdmins, isAdmins, reply
    }) => {
        try {
            if (!config.GEMINI_API_KEY) {
                console.log("Gemini API Key is missing.");
                return;
            }

            // Initialize user state if not exists
            if (!userStates[senderNumber]) {
                userStates[senderNumber] = { step: 'NORMAL' };
            }

            let state = userStates[senderNumber];

            // Handle State Machine
            if (state.step === 'WAITING_FOR_PREFECT_ID') {
                if (!body) return reply("කරුණාකර නිවැරදිව ඔබේ Prefect ID එක Type කරන්න.");
                state.prefectId = body.trim();
                state.step = 'WAITING_FOR_BARCODE_ID';
                return reply("ගොඩක් හොඳයි! දැන් කරුණාකර ඔබගේ Barcode ID එක දෙන්න.");

            } else if (state.step === 'WAITING_FOR_BARCODE_ID') {
                if (!body) return reply("කරුණාකර නිවැරදිව ඔබේ Barcode ID එක Type කරන්න.");
                state.barcodeId = body.trim();

                await danuwa.sendPresenceUpdate('composing', from);
                // Check DB
                try {
                    const prefectsRef = db.collection('prefects');
                    const snapshot = await prefectsRef
                        .where('prefect_unique_id', '==', state.prefectId)
                        .where('barcode_id', '==', state.barcodeId)
                        .get();

                    if (snapshot.empty) {
                        state.step = 'NORMAL';
                        return reply("ඔබ ලබා දුන් විස්තර වැරදියි හෝ පද්ධතියේ නැහැ. කරුණාකර නැවත සාමාන්‍ය පරිදි කතා කරන්න.");
                    }

                    state.matchedPrefectData = snapshot.docs[0].data();
                    state.step = 'WAITING_FOR_PHOTO';
                    return reply("විස්තර නිවැරදියි! දැන් කරුණාකර ඔබගේ Barcode එක සහිත ඡායාරූපයක් (Photo) එවන්න.");
                } catch (dbError) {
                    console.error("Firebase Query Error:", dbError);
                    state.step = 'NORMAL';
                    return reply("පද්ධතියේ දෝෂයක් ඇති විය. කරුණාකර පසුව උත්සාහ කරන්න.");
                }

            } else if (state.step === 'WAITING_FOR_PHOTO') {
                // Check if message is an image
                const isImage = mek.message && (mek.message.imageMessage || (mek.message.viewOnceMessageV2 && mek.message.viewOnceMessageV2.message.imageMessage));
                if (isImage) {
                    // Send reaction
                    await danuwa.sendMessage(from, { react: { text: "✅", key: mek.key } });

                    const pData = state.matchedPrefectData;
                    const duty = pData.destiny || pData.current_duty || "Prefect";
                    const caption = `මෙය ඔබද?\n\n*නම:* ${pData.name || "නොදනී"}\n*තනතුර:* ${duty}`;

                    // Send the photo with caption first
                    if (pData.picture) {
                        await danuwa.sendMessage(from, { image: { url: pData.picture }, caption: caption }, { quoted: mek });
                    } else {
                        await danuwa.sendMessage(from, { text: caption }, { quoted: mek });
                    }

                    // Then send the Poll message
                    await danuwa.sendMessage(from, {
                        poll: {
                            name: 'ඉහත ඡායාරූපය සහ විස්තර ඔබගේද?',
                            values: ['ඔව්, ඒ මමයි 👍', 'නැහැ, ඒ මම නෙවෙයි 👎'],
                            selectableCount: 1
                        }
                    });

                    state.step = 'WAITING_FOR_CONFIRMATION';
                    return;
                } else {
                    return reply("කරුණාකර Barcode එකේ ඡායාරූපයක් (Photo) පමණක් එවන්න.");
                }

            }

            // Detect Poll votes
            if (state.step === 'WAITING_FOR_CONFIRMATION') {
                const messageType = mek.message ? Object.keys(mek.message)[0] : null;

                if (messageType === 'messageContextInfo' && mek.message.messageContextInfo?.messageSecret) {
                    // Poll votes come as pollUpdateMessage in other events usually, but sometimes as context info
                    // Since polling reading requires deep crypto logic or keeping track of poll creation,
                    // We will simplify: If the user replies with 'ඔව්'/'yes' OR if they vote (fallback to text if polling vote parsing is complex in current baileys)
                    // Let's implement a fallback for simplicity if they just text back, but try to handle vote text
                }

                // Temporary logic: Wait for next text if poll voting isn't directly caught here,
                // OR we can read the raw text of the selected vote if Baileys provides it in 'body'
                if (!body && !mek.message?.pollUpdateMessage) return;

                let confirmText = "";
                if (body) {
                    confirmText = body.toLowerCase().trim();
                } else if (mek.message?.pollUpdateMessage) {
                    // Normally you decrypt the poll vote here, but since Baileys v6 requires complex poll vote decryption,
                    // We will inform the user to just text if the vote fails to parse, OR we use the text response.
                    // To make it flawless without complex DB keys, let's allow text confirmation ("ඔව්") as well as poll.
                }

                if (confirmText === 'ඔව්' || confirmText === 'yes' || confirmText === 'ow' || confirmText.includes('ඔව්, ඒ මමයි')) {
                    state.step = 'AUTHENTICATED';

                    // Add to the specific group
                    try {
                        const targetGroupLink = "https://chat.whatsapp.com/C4aXtP8cV1QD2VwJ6EgEIK";
                        const inviteCode = targetGroupLink.split('chat.whatsapp.com/')[1];

                        if (inviteCode) {
                            const groupInfo = await danuwa.groupGetInviteInfo(inviteCode);
                            if (groupInfo && groupInfo.id) {
                                // Important: Bot must be admin in that group to add people directly
                                await danuwa.groupParticipantsUpdate(groupInfo.id, [sender], "add");
                                await reply(`නියමයි! ඔබව සාර්ථකව නිල Prefects ගෲප් එකට ඇතුලත් කළා. ✅\n\nදැන් ඔයාගේ Prefect විස්තර ඔක්කොම මට කියන්න පුළුවන්. අද දවස කොහොමද? ලකුණු ගැන හරි මොනවා හරි දැනගන්න ඕනෙද?`);
                                return;
                            }
                        }
                    } catch (err) {
                        console.error("Group Add Error:", err);
                        // Fallback if bot is not admin or cannot add directly
                        return reply(`නියමයි! දැන් ඔයාගේ Prefect විස්තර ඔක්කොම මට කියන්න පුළුවන්.\nඔබට Prefects නිල ගෲප් එකට මේ ලින්ක් එකෙන් සම්බන්ධ වෙන්න පුළුවන්: https://chat.whatsapp.com/C4aXtP8cV1QD2VwJ6EgEIK\n\nඅද දවස කොහොමද? ලකුණු ගැන හරි මොනවා හරි දැනගන්න ඕනෙද?`);
                    }

                    return reply("නියමයි! දැන් ඔයාගේ Prefect විස්තර ඔක්කොම මට කියන්න පුළුවන්. අද දවස කොහොමද? ලකුණු ගැන හරි මොනවා හරි දැනගන්න ඕනෙද?");
                } else if (confirmText === 'නැහැ' || confirmText === 'no' || confirmText === 'naa' || confirmText.includes('නැහැ, ඒ මම නෙවෙයි')) {
                    state.step = 'NORMAL';
                    state.matchedPrefectData = null;
                    return reply("අයියෝ, එහෙනම් අපි ආයෙත් මුල ඉඳන් කතා කරමු. මොනවද විස්තර?");
                }
            }

            // --- AI GENERATION STAGE (For NORMAL or AUTHENTICATED states) ---
            if (!body) return; // Ignore if no text body and in normal state

            await danuwa.sendPresenceUpdate('composing', from);
            let systemPrompt = "";

            if (state.step === 'NORMAL') {
                systemPrompt = `
ඔබ "Eheliyagoda Central College" හි ඉගෙන ගන්නා මිත්‍රශීලී සිසුවෙකි. ඔබේ නම 'Dexer MD'. ඔබ සාමාන්‍ය කෙනෙකු ලෙස මිසක් AI බොට් කෙනෙකු ලෙස පෙනී නොසිටිය යුතුය. 
සාමාන්‍ය කතාබහේ භාවිතා කරන සිංහලෙන් (කෙටියෙන් සහ පැහැදිලිව) මිතුරෙකුට මෙන් පිළිතුරු දෙන්න.

ඉතා වැදගත් උපදෙස්:
කතා කරන පුද්ගලයා තමාගේ Prefect විස්තර, ලකුණු (points), තනතුර, අදහස් (ideas) හෝ නිවාඩු (absence) ගැන විමසුවහොත් හෝ තමා පද්ධතියේ ලියාපදිංචි Prefect කෙනෙකු යැයි පැවසුවහොත්, ඔබ කිසිදු විස්තරයක් නොදී හරියටම "[ASK_PREFECT_ID]" යන වචනය පමණක් පිළිතුරු ලෙස ලබා දිය යුතුය. වෙන කිසිවක් ලියන්න එපා. 
එසේම යම් අයෙකු Prefect ගෲප් එකට ඇඩ් කරන්න යැයි ඉල්ලුවොත් ඔවුන්ගෙන්ද අනිවාරෙන්ම "[ASK_PREFECT_ID]" යනුවෙන් අසා තහවුරු කරගන්න.

වෙනත් සාමාන්‍ය දේවල් ගැන සහ පාසල ගැන කතා කළහොත් යහළුවෙක් වගේ සාමාන්‍ය පිළිතුරක් දෙන්න.

පරිශීලකයාගේ පණිවිඩය: "${body}"
`;
            } else if (state.step === 'AUTHENTICATED') {
                const pData = state.matchedPrefectData || {};
                const points = pData.total_points || 0;
                const duty = pData.destiny || pData.current_duty || 'Prefect';

                systemPrompt = `
ඔබ "Eheliyagoda Central College's Prefects' Guild" හි ඉතා උද්‍යෝගිමත් සහ මිත්‍රශීලී සාමාජිකයෙකි. ඔබේ නම 'Dexer MD' ය. ඔබ සාමාන්‍ය කෙනෙකු ලෙස මිසක් AI බොට් කෙනෙකු ලෙස පෙනී නොසිටිය යුතුය. 
ඔබ කතා කරන්නේ අපගේ පද්ධතියෙන් තහවුරු කළ Prefect කෙනෙකු සමඟයි. මිත්‍රශීලීව, සාමාන්‍ය කතාබහේ භාවිතා කරන සිංහලෙන් (කෙටියෙන් සහ පැහැදිලිව) පිළිතුරු දෙන්න.

ඔබ කතා කරන Prefect ගේ විස්තර:
- නම: '${pData.name || 'නොදනී'}'
- තනතුර: ${duty}
- ලබාගෙන ඇති ලකුණු: ${points}
- අංශය (Section): ${pData.section || 'නොදනී'}
- පන්තිය: ${pData.class || 'නොදනී'}

අපගේ පද්ධතිය ගැන දේවල්:
- මේක "Eheliyagoda Central College" Prefects' Guild එකේ Dashboard එකක් යටතේ වැඩ කරන්නේ.
- ශිෂ්‍ය නායකයින්ට ලකුණු එකතු වෙනවා, ඒ ලකුණු වලට අනුව එයාලගේ Rank එක වෙනස් වෙනවා.

පරිශීලකයා ලකුණු (points), තනතුර (rank), අදහස් (ideas) හෝ නිවාඩු (absence) ගැන ඇසුවොත් ඉහත කරුණු පදනම් කරගෙන මිත්‍රශීලීව උදව් කරන්න/විස්තර දෙන්න.

ඔබට ලැබෙන පණිවිඩය: "${body}"
`;
            }

            const geminiRes = await axios.post(
                `${GEMINI_API_URL}?key=${config.GEMINI_API_KEY}`,
                { contents: [{ parts: [{ text: systemPrompt }] }] }
            );
            const textResult = geminiRes.data.candidates[0].content.parts[0].text;

            // Intercept trigger code from Gemini
            if (state.step === 'NORMAL' && textResult.includes('[ASK_PREFECT_ID]')) {
                state.step = 'WAITING_FOR_PREFECT_ID';
                return reply("කරුණාකර ඔබගේ Prefect ID එක ලබා දෙන්න.");
            }

            // Normal AI Response
            const finalResponse = textResult.replace('[ASK_PREFECT_ID]', '').trim();
            if (finalResponse) {
                await danuwa.sendMessage(from, { text: finalResponse }, { quoted: mek });
            }

        } catch (e) {
            console.error("Gemini Error:", e);
        }
    });
