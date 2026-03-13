const { cmd } = require('../command');
const { exec } = require('child_process');

cmd({
    pattern: "up",
    desc: "Restart the bot.",
    category: "owner",
    filename: __filename,
    fromMe: true // Ensures only the owner can use it
},
    async (danuwa, mek, m, {
        from, reply, senderNumber, isOwner
    }) => {
        try {
            // Check if the sender is exactly 94779912589
            if (senderNumber !== '94779912589') {
                return reply("මෙම වරප්‍රසාදය හිමිවන්නේ බොට්ගේ අයිතිකරුට (0779912589) පමණි.");
            }

            await reply("🔄 බොට් නැවත පණගන්වමින් (Restarting) පවතී...");

            // Execute the restart command
            exec('pm2 restart all || node index.js', (err, stdout, stderr) => {
                if (err) {
                    console.error("Restart error:", err);
                    // Fallback to simpler method if not using PM2
                    process.exit(1);
                }
            });
            // Also explicitly close the process if exec alone doesn't terminate it
            setTimeout(() => {
                process.exit(1);
            }, 1000);

        } catch (e) {
            console.error("Restart Error:", e);
            reply("Restart කිරීමේදී දෝෂයක් ඇතිවිය.");
        }
    });
