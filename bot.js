require('dotenv').config();
process.env.NTBA_FIX_350 = 1; // Fix deprecation warning
const TelegramBot = require('node-telegram-bot-api');
const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const ora = require('ora');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

// Konfigurasi Environment
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID'; 
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TARGET_URL = process.env.TARGET_URL || 'https://dexscreener.com/solana';

// Mendukung multiple API keys, dipisahkan dengan koma
const ZENROWS_API_KEYS = (process.env.ZENROWS_API_KEYS || process.env.ZENROWS_API_KEY || '').split(',').map(k => k.trim()).filter(k => k.length > 0);
let currentApiKeyIndex = 0;

// Inisialisasi AWS DynamoDB
const dynamodb = new DynamoDBClient({ region: AWS_REGION });
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === Variabel Global Manajemen State ===
let isShuttingDown = false;
let isScrapingActive = false; // Default: Berhenti saat awal boot
let isScrapingRunning = false; // Mencegah overlapping loop fungsi asinkron
let userStates = {}; 

let currentFilter = {
    minTraders: 0,
    minVolume: 0,
    minLiquidity: 0,
    minPriceChange5m: 0,
    minPriceChange24h: 0
};

// === FUNGSI DATABASE ===
async function loadConfigFromDB() {
    try {
        const command = new GetItemCommand({
            TableName: 'BotConfig',
            Key: { configId: { S: 'default' } }
        });
        const response = await dynamodb.send(command);
        if (response.Item) {
            currentFilter.minTraders = Number(response.Item.minTraders.N);
            currentFilter.minVolume = Number(response.Item.minVolume.N);
            currentFilter.minLiquidity = Number(response.Item.minLiquidity.N);
            currentFilter.minPriceChange5m = Number(response.Item.minPriceChange5m.N);
            currentFilter.minPriceChange24h = Number(response.Item.minPriceChange24h.N);
            return true;
        }
    } catch (e) {
        console.error("Gagal load config dari DB:", e.message);
    }
    return false;
}

async function saveConfigToDB(filter) {
    const command = new UpdateItemCommand({
        TableName: 'BotConfig',
        Key: { configId: { S: 'default' } },
        UpdateExpression: 'SET minTraders = :t, minVolume = :v, minLiquidity = :l, minPriceChange5m = :p5, minPriceChange24h = :p24',
        ExpressionAttributeValues: {
            ':t': { N: filter.minTraders.toString() },
            ':v': { N: filter.minVolume.toString() },
            ':l': { N: filter.minLiquidity.toString() },
            ':p5': { N: filter.minPriceChange5m.toString() },
            ':p24': { N: filter.minPriceChange24h.toString() }
        }
    });
    await dynamodb.send(command);
}

// === TELEGRAM INTERACTIVE DASHBOARD ===
function sendDashboard(chatId, messageIdToEdit = null) {
    const statusText = isScrapingActive ? "🟢 *RUNNING*" : "🔴 *STOPPED*";
    
    const text = `🤖 *DexScreener Bot Dashboard*\n\n` +
                 `Status Mesin: ${statusText}\n\n` +
                 `🎯 *Filter Saat Ini (RAM):*\n` +
                 `👥 Min Traders: ${currentFilter.minTraders}\n` +
                 `📊 Min Volume: $${currentFilter.minVolume}\n` +
                 `💧 Min Liquidity: $${currentFilter.minLiquidity}\n` +
                 `📈 Min Change 5m: ${currentFilter.minPriceChange5m}%\n` +
                 `📈 Min Change 24h: ${currentFilter.minPriceChange24h}%`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: isScrapingActive ? '⏹️ STOP SCRAPER' : '▶️ START SCRAPER', callback_data: isScrapingActive ? 'cmd_stop' : 'cmd_start' }
            ],
            [
                { text: `✏️ Traders (${currentFilter.minTraders})`, callback_data: 'edit_traders' },
                { text: `✏️ Vol ($${currentFilter.minVolume})`, callback_data: 'edit_volume' }
            ],
            [
                { text: `✏️ Liq ($${currentFilter.minLiquidity})`, callback_data: 'edit_liquidity' }
            ],
            [
                { text: `✏️ 5m (${currentFilter.minPriceChange5m}%)`, callback_data: 'edit_5m' },
                { text: `✏️ 24h (${currentFilter.minPriceChange24h}%)`, callback_data: 'edit_24h' }
            ],
            [
                { text: '💾 SIMPAN KE DATABASE AWS', callback_data: 'save_db' }
            ]
        ]
    };

    if (messageIdToEdit) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageIdToEdit, parse_mode: 'Markdown', reply_markup: keyboard }).catch(()=>{});
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(console.error);
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    if (msg.text === '/start' || msg.text === '/menu') {
        userStates[chatId] = null; // reset state
        sendDashboard(chatId);
        return;
    }

    // Jika user sedang dalam mode Edit
    if (userStates[chatId] && msg.text && !msg.text.startsWith('/')) {
        const val = parseFloat(msg.text.trim());
        if (isNaN(val)) {
            bot.sendMessage(chatId, "❌ Harap masukkan angka yang valid.");
            return;
        }

        switch (userStates[chatId]) {
            case 'edit_traders': currentFilter.minTraders = val; break;
            case 'edit_volume': currentFilter.minVolume = val; break;
            case 'edit_liquidity': currentFilter.minLiquidity = val; break;
            case 'edit_5m': currentFilter.minPriceChange5m = val; break;
            case 'edit_24h': currentFilter.minPriceChange24h = val; break;
        }
        
        userStates[chatId] = null; // clear state
        bot.sendMessage(chatId, "✅ Nilai diupdate secara sementara (Tekan 'SIMPAN KE DATABASE' untuk memanenkannya).", { parse_mode: 'Markdown' });
        sendDashboard(chatId);
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data === 'cmd_start') {
        if (!isScrapingActive) {
            isScrapingActive = true;
            bot.answerCallbackQuery(query.id, { text: "▶️ Scraper Dimulai!" });
            sendDashboard(chatId, msgId);
            if (!isScrapingRunning) {
                startScrapingCycle();
            }
        } else {
            bot.answerCallbackQuery(query.id, { text: "Bot sudah berjalan" });
        }
    } else if (data === 'cmd_stop') {
        isScrapingActive = false;
        bot.answerCallbackQuery(query.id, { text: "⏹️ Scraper Dihentikan!" });
        sendDashboard(chatId, msgId);
    } else if (data.startsWith('edit_')) {
        userStates[chatId] = data;
        let promptText = "";
        if (data === 'edit_traders') promptText = "Kirimkan angka baru untuk *Min Traders*:";
        if (data === 'edit_volume') promptText = "Kirimkan angka baru untuk *Min Volume ($)*:";
        if (data === 'edit_liquidity') promptText = "Kirimkan angka baru untuk *Min Liquidity ($)*:";
        if (data === 'edit_5m') promptText = "Kirimkan angka baru untuk *Min Change 5m (%)*:";
        if (data === 'edit_24h') promptText = "Kirimkan angka baru untuk *Min Change 24h (%)*:";
        
        bot.sendMessage(chatId, promptText, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(query.id);
    } else if (data === 'save_db') {
        try {
            await saveConfigToDB(currentFilter);
            bot.answerCallbackQuery(query.id, { text: "✅ Tersimpan Permanen di Database AWS!", show_alert: true });
        } catch (e) {
            bot.answerCallbackQuery(query.id, { text: "❌ Gagal menyimpan", show_alert: true });
        }
    }
});

// === HELPER FUNCTION ===
function parseMetric(str) {
    if (!str || str === '-' || str === '') return 0;
    let val = str.replace(/[$,%]/g, '');
    let multiplier = 1;
    if (val.toUpperCase().includes('K')) {
        multiplier = 1000;
        val = val.replace(/K/i, '');
    } else if (val.toUpperCase().includes('M')) {
        multiplier = 1000000;
        val = val.replace(/M/i, '');
    } else if (val.toUpperCase().includes('B')) {
        multiplier = 1000000000;
        val = val.replace(/B/i, '');
    }
    const parsed = parseFloat(val);
    return isNaN(parsed) ? 0 : parsed * multiplier;
}

// === LOGIKA SCRAPING UTAMA (ZENROWS API) ===
async function startScrapingCycle() {
    if (isShuttingDown || !isScrapingActive) {
        isScrapingRunning = false;
        console.log("🛑 Bot dimatikan. Menunggu perintah Start...");
        return;
    }
    
    isScrapingRunning = true;
    let scrapeSpinner = null;
    let processSpinner = null;
    let scrapedData = [];
    
    try {
        scrapeSpinner = ora('1. Bot melakukan Request ke ZenRows API... (proses)').start();
        console.log(`\n  ↳ 1.1 Mengirim permintaan ke ZenRows AI menggunakan API Key ke-${currentApiKeyIndex + 1}...`);
        
        let html = null;
        let attempt = 0;
        
        while (attempt < ZENROWS_API_KEYS.length) {
            const currentKey = ZENROWS_API_KEYS[currentApiKeyIndex];
            try {
                const response = await axios({
                    url: 'https://api.zenrows.com/v1/',
                    method: 'GET',
                    params: {
                        'url': TARGET_URL,
                        'apikey': currentKey,
                        'js_render': 'true',
                        'antibot': 'true',
                        'premium_proxy': 'true',
                        'wait_for': '.ds-dex-table-row',
                        'js_instructions': JSON.stringify([
                            { "wait": 2000 },
                            { "evaluate": "const target = Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim().toUpperCase() === 'TRADERS'); if (target) target.click();" },
                            { "wait": 4000 }
                        ])
                    },
                    timeout: 90000 
                });
                html = response.data;
                break; // Sukses, keluar dari loop
            } catch (err) {
                const status = err.response ? err.response.status : null;
                console.error(`  ↳ Error dengan API Key ke-${currentApiKeyIndex + 1} (${currentKey.substring(0, 4)}...): Status ${status || err.message}`);
                
                // Rotasi ke API key berikutnya
                currentApiKeyIndex = (currentApiKeyIndex + 1) % ZENROWS_API_KEYS.length;
                attempt++;
                
                if (attempt < ZENROWS_API_KEYS.length) {
                    console.log(`  ↳ Mencoba API Key cadangan ke-${currentApiKeyIndex + 1}...`);
                }
            }
        }
        
        if (!html) {
            throw new Error("Semua API Key ZenRows gagal atau kehabisan limit kredit!");
        }
        
        console.log("  ↳ 1.2 Mengekstrak seluruh data HTML token dengan Cheerio...");
        const $ = cheerio.load(html);
        
        // --- DYNAMIC COLUMN MAPPING ---
        // Karena custom URL bisa menambah/mengurangi kolom (misal: kolom Txns), 
        // kita mendeteksi indeks kolom secara dinamis dari header.
        let col = { volume: 3, traders: 4, change5m: 5, change24h: 8, liquidity: 9 };
        $('.ds-table-th').each((i, el) => {
            const text = $(el).text().toUpperCase().trim();
            if (text.includes('VOLUME')) col.volume = i;
            if (text.includes('TRADERS') || text.includes('MAKERS')) col.traders = i;
            if (text === '5M') col.change5m = i;
            if (text === '24H') col.change24h = i;
            if (text.includes('LIQUIDITY')) col.liquidity = i;
        });
        
        const rows = $('.ds-dex-table-row').slice(0, 10);
        if (rows.length === 0) {
            throw new Error("Tidak menemukan tabel data. Kelas mungkin berubah atau loading tertunda.");
        }
        
        console.log(`  ↳ 1.3 Berhasil mengekstrak ${rows.length} token teratas... (Kolom terdeteksi: Vol=${col.volume}, Traders=${col.traders}, Liq=${col.liquidity})`);
        
        rows.each((i, el) => {
            const addressLink = $(el).attr('href');
            const address = addressLink ? addressLink.split('/').pop() : 'unknown';
            const name = $(el).find('.ds-dex-table-row-base-token-symbol').text().trim() || 'UNKNOWN';
            
            let cells = [];
            $(el).find('.ds-table-data-cell').each((j, cellEl) => {
                cells.push($(cellEl).text().trim());
            });
            
            // Parse metrik menggunakan indeks yang terdeteksi secara dinamis
            const volume = parseMetric(cells[col.volume] || "0");
            const traders = parseMetric(cells[col.traders] || "0");
            const change5m = parseMetric(cells[col.change5m] || "0");
            const change24h = parseMetric(cells[col.change24h] || "0");
            const liquidity = parseMetric(cells[col.liquidity] || "0");
            
            scrapedData.push({ address, name, cells, volume, traders, change5m, change24h, liquidity });
        });
        
        scrapeSpinner.succeed('1. Ekstraksi Data via UI Click... (DONE)');
        
        // --- INSTANCE 2 ---
        processSpinner = ora('2. Mengolah data hasil scraping... (proses)').start();
        console.log("\n  ↳ 2.1 Menyimpan Top 10 ke debug_raw_data.json...");
        fs.writeFileSync('debug_raw_data.json', JSON.stringify(scrapedData, null, 2));
        
        console.log("  ↳ 2.2 Memfilter data menggunakan pengaturan Telegram...");
        let passedTokens = [];
        
        for (const pToken of scrapedData) {
            let lastTraders = 0;
            let lastVolume = 0;
            let lastAlertTime = 0;
            
            try {
                const getCmd = new GetItemCommand({
                    TableName: 'DexScreenerPairs',
                    Key: { pairAddress: { S: pToken.address } }
                });
                const res = await dynamodb.send(getCmd);
                if (res.Item) {
                    lastTraders = Number(res.Item.lastTraders?.N || 0);
                    lastVolume = Number(res.Item.lastVolume?.N || 0);
                    lastAlertTime = Number(res.Item.lastAlertTime?.N || 0);
                }
            } catch (e) {
                // Ignore DB error, anggap item baru
            }
            
            const now = Date.now();
            const timeSinceLastAlert = now - lastAlertTime;
            const fiveMinutes = 5 * 60 * 1000;
            
            let conditionMet = false;
            let conditionType = "";
            
            const meetsBasicRAM = (
                pToken.traders >= currentFilter.minTraders &&
                pToken.volume >= currentFilter.minVolume &&
                pToken.liquidity >= currentFilter.minLiquidity &&
                pToken.change5m >= currentFilter.minPriceChange5m &&
                pToken.change24h >= currentFilter.minPriceChange24h
            );
            
            if (meetsBasicRAM) {
                if (lastAlertTime === 0) {
                    // KONDISI A
                    conditionMet = true;
                    conditionType = "Baru Masuk Filter (Kondisi A)";
                } else {
                    // KONDISI B (Surge Traders >= 50% atau Volume >= 100%, dan jeda > 5 menit)
                    const tradersSurge = lastTraders > 0 && (pToken.traders >= lastTraders * 1.5);
                    const volumeSurge = lastVolume > 0 && (pToken.volume >= lastVolume * 2.0);
                    
                    if ((tradersSurge || volumeSurge) && timeSinceLastAlert > fiveMinutes) {
                        conditionMet = true;
                        conditionType = "Surge Terdeteksi (Kondisi B)";
                    }
                }
            }
            
            if (conditionMet) {
                pToken.conditionType = conditionType;
                passedTokens.push(pToken);
                
                try {
                    const updateCmd = new UpdateItemCommand({
                        TableName: 'DexScreenerPairs',
                        Key: { pairAddress: { S: pToken.address } },
                        UpdateExpression: 'SET lastTraders = :t, lastVolume = :v, lastAlertTime = :a',
                        ExpressionAttributeValues: {
                            ':t': { N: pToken.traders.toString() },
                            ':v': { N: pToken.volume.toString() },
                            ':a': { N: now.toString() }
                        }
                    });
                    await dynamodb.send(updateCmd);
                } catch (e) {}
            }
        }
        
        console.log(`  ↳ 2.3 Ditemukan ${passedTokens.length} token lolos filter.`);
        
        for (const t of passedTokens) {
            const msg = `🚀 *DexScreener Alert - ${t.conditionType}*\n\n` +
                        `*Token:* ${t.name}\n` +
                        `*Address:* \`${t.address}\`\n\n` +
                        `👥 Traders: ${t.traders}\n` +
                        `📊 Volume: $${t.volume}\n` +
                        `💧 Liquidity: $${t.liquidity}\n` +
                        `📈 5m Change: ${t.change5m}%\n` +
                        `📈 24h Change: ${t.change24h}%\n\n` +
                        `[🔗 View on DexScreener](${TARGET_URL}/${t.address})`;
            
            bot.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: false }).catch(console.error);
        }
        
        processSpinner.succeed('2. Mengolah data hasil scraping... (DONE)');
        
    } catch (e) {
        if (scrapeSpinner && scrapeSpinner.isSpinning) scrapeSpinner.fail(`1. Bot API Error... (FAILED: ${e.message})`);
        else if (processSpinner && processSpinner.isSpinning) processSpinner.fail(`2. Data Error... (FAILED: ${e.message})`);
        else console.error("\nTerjadi error pada siklus:", e.message);
        
        try { bot.sendMessage(ADMIN_CHAT_ID, `❌ *API Scraping Error:*\n${e.message}`, { parse_mode: 'Markdown' }); } catch (err) {}
    } finally {
        if (isScrapingActive && !isShuttingDown) {
            console.log("\n⏳ Menunggu jeda 1 menit...\n");
            setTimeout(startScrapingCycle, 60000);
        } else {
            console.log("🛑 Siklus Scraper berhenti atas instruksi.");
            isScrapingRunning = false;
        }
    }
}

// === GRACEFUL SHUTDOWN (PM2) ===
const shutdown = async (signal) => {
    console.log(`\nMenerima sinyal ${signal}. Menutup proses...`);
    isShuttingDown = true;
    isScrapingActive = false;
    
    try { await bot.stopPolling(); } catch(e) {}
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// === INISIALISASI PROGRAM ===
async function init() {
    console.log("🚀 Inisialisasi Bot DexScreener (Telegram Dashboard UI)...");
    
    // 1. Load config awal dari DB
    await loadConfigFromDB();
    console.log("✅ Config dimuat dari DB ke RAM.");
    
    console.log("ℹ️ Bot dalam kondisi STOPPED. Buka Telegram dan ketik /start untuk menyalakan scraper.");
}

init();
