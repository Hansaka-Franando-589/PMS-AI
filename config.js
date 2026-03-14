const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env' });

function convertToBool(text, fault = 'true') {
    return text === fault ? true : false;
}
module.exports = {
    SESSION_ID: process.env.SESSION_ID || "",
    ALIVE_IMG: process.env.ALIVE_IMG || "https://i.ibb.co/WpNDqSrd/freepik-highcontrast-dark-hackerthemed-logo-design-for-a-h-3878.png",
    ALIVE_MSG: process.env.ALIVE_MSG || "*Hello👋 Dexer MD Is Alive Now😍*",
    BOT_OWNER: '94742053080',  // Replace with the owner's phone number
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "AIzaSyDB4kK8LuDfYkwvExbWn0KVLNm2P5kvftA",

};
