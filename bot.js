require('dotenv').config();
const { chromium } = require('playwright');
const TelegramBot = require('node-telegram-bot-api');
const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const ora = require('ora');
const fs = require('fs');

// Konfigurasi Environment (Gunakan .env di production)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID'; // Chat ID untuk menerima notifikasi
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Inisialisasi AWS DynamoDB (Kredensial otomatis diambil dari environment / IAM Role EC2)
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

// Inisialisasi Telegram Bot (Mode Polling)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === Variabel Global Manajemen Memori & State ===
let globalBrowser = null;
let isShuttingDown = false;
let userStates = {}; // Menyimpan state percakapan user (DRAFT_MODE)

// RAM State (Default jika belum ada di DB)
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
        console.error("Gagal load config dari DB (Mungkin tabel belum ada/kosong):", e.message);
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

// === TELEGRAM BOT LOGIC ===
bot.onText(/\/filter/, (msg) => {
    const chatId = msg.chat.id;
    const text = `🎯 *Filter Aktif Saat Ini:*\n\n` +
                 `👥 Min Traders: ${currentFilter.minTraders}\n` +
                 `📊 Min Volume: $${currentFilter.minVolume}\n` +
                 `💧 Min Liquidity: $${currentFilter.minLiquidity}\n` +
                 `📈 Min Change 5m: ${currentFilter.minPriceChange5m}%\n` +
                 `📈 Min Change 24h: ${currentFilter.minPriceChange24h}%`;
    
    bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '📝 Edit Filter', callback_data: 'edit_filter' }]]
        }
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'edit_filter') {
        userStates[chatId] = { mode: 'DRAFT_MODE', draft: null };
        bot.sendMessage(chatId, "Kirim 5 angka berurutan yang dipisah spasi (Traders Volume Liq %5m %24h).\n\nContoh: `25 1000 500 15 -5`", { parse_mode: 'Markdown' });
    } else if (data === 'save_filter') {
        if (userStates[chatId] && userStates[chatId].draft) {
            currentFilter = { ...userStates[chatId].draft };
            try {
                await saveConfigToDB(currentFilter);
                bot.sendMessage(chatId, "✅ Filter berhasil disimpan ke Database dan RAM diupdate!");
            } catch (error) {
                bot.sendMessage(chatId, `❌ Gagal menyimpan ke Database AWS: ${error.message}`);
            }
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "❌ Draft tidak ditemukan atau sudah kadaluarsa.");
        }
    } else if (data === 'cancel_filter') {
        delete userStates[chatId];
        bot.sendMessage(chatId, "❌ Edit filter dibatalkan.");
    }
    
    bot.answerCallbackQuery(query.id).catch(() => {});
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    // Deteksi jika user sedang dalam state DRAFT_MODE dan tidak mengetik command
    if (msg.text && !msg.text.startsWith('/') && userStates[chatId] && userStates[chatId].mode === 'DRAFT_MODE') {
        const parts = msg.text.trim().split(/\s+/);
        if (parts.length === 5) {
            const [t, v, l, p5, p24] = parts.map(Number);
            if (parts.every(p => !isNaN(p))) {
                userStates[chatId].draft = {
                    minTraders: t,
                    minVolume: v,
                    minLiquidity: l,
                    minPriceChange5m: p5,
                    minPriceChange24h: p24
                };
                
                const preview = `🔍 *Preview Filter Baru:*\n\n` +
                                `👥 Traders: ${t}\n` +
                                `📊 Volume: $${v}\n` +
                                `💧 Liquidity: $${l}\n` +
                                `📈 Change 5m: ${p5}%\n` +
                                `📈 Change 24h: ${p24}%\n\n` +
                                `Simpan pengaturan ini?`;
                
                bot.sendMessage(chatId, preview, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💾 SAVE', callback_data: 'save_filter' }, { text: '❌ CANCEL', callback_data: 'cancel_filter' }]
                        ]
                    }
                });
            } else {
                bot.sendMessage(chatId, "❌ Format salah. Pastikan semua adalah angka.\nContoh: `25 1000 500 15 -5`", { parse_mode: 'Markdown' });
            }
        } else {
            bot.sendMessage(chatId, "❌ Harus tepat 5 angka dipisahkan spasi.\nContoh: `25 1000 500 15 -5`", { parse_mode: 'Markdown' });
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

// === LOGIKA SCRAPING UTAMA ===
async function startScrapingCycle() {
    if (isShuttingDown) return;
    
    let context = null;
    let page = null;
    let scrapeSpinner = null;
    let processSpinner = null;
    let scrapedData = [];
    
    try {
        // --- INSTANCE 1 ---
        scrapeSpinner = ora('1. Bot melakukan web scraping... (proses)').start();
        console.log("\n  ↳ 1.1 Membuka URL DexScreener...");
        
        context = await globalBrowser.newContext();
        page = await context.newPage();
        
        await page.goto('https://dexscreener.com/solana', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log("  ↳ 1.2 Memvalidasi sorting data TRADER...");
        try {
            // Cek dan klik header TRADERS jika perlu
            const tradersBtn = page.locator('button', { hasText: 'TRADERS' }).first();
            if (await tradersBtn.isVisible()) {
                await tradersBtn.click();
                await page.waitForTimeout(2000); // Tunggu re-render
            }
        } catch (e) {
            // Abaikan jika tombol TRADERS tidak ditemukan secara spesifik
        }
        
        console.log("  ↳ 1.3 Mengekstrak data Top 10 token...");
        await page.waitForSelector('.ds-dex-table-row', { timeout: 15000 });
        const rows = await page.locator('.ds-dex-table-row').all();
        
        for (let i = 0; i < Math.min(10, rows.length); i++) {
            const row = rows[i];
            const data = await row.evaluate((el) => {
                const addressLink = el.querySelector('a.ds-dex-table-row-link');
                const address = addressLink ? addressLink.href.split('/').pop() : 'unknown';
                const name = el.querySelector('.ds-dex-table-row-base-token-symbol')?.innerText || 'UNKNOWN';
                const cells = Array.from(el.querySelectorAll('.ds-table-data-cell')).map(c => c.innerText.trim());
                return { address, name, cells };
            });
            scrapedData.push(data);
        }
        
        console.log("  ↳ 1.4 Data berhasil ditarik ke server.");
        scrapeSpinner.succeed('1. Bot melakukan web scraping... (DONE)');
        
        // --- INSTANCE 2 ---
        processSpinner = ora('2. Mengolah data hasil scraping... (proses)').start();
        console.log("\n  ↳ 2.1 Mengirim data file ke debug_raw_data.json...");
        fs.writeFileSync('debug_raw_data.json', JSON.stringify(scrapedData, null, 2));
        
        console.log("  ↳ 2.2 Memfilter data menggunakan pengaturan Telegram...");
        let passedTokens = [];
        
        for (const token of scrapedData) {
            // Asumsi mapping kolom DexScreener (Bisa disesuaikan dari debug_raw_data.json)
            // 3: Volume, 4: Makers/Traders, 5: 5M, 8: 24H, 9: Liquidity
            const volumeStr = token.cells[3] || "0";
            const tradersStr = token.cells[4] || "0";
            const change5mStr = token.cells[5] || "0";
            const change24hStr = token.cells[8] || "0";
            const liquidityStr = token.cells[9] || "0";
            
            const volume = parseMetric(volumeStr);
            const traders = parseMetric(tradersStr);
            const change5m = parseMetric(change5mStr);
            const change24h = parseMetric(change24hStr);
            const liquidity = parseMetric(liquidityStr);
            
            const pToken = {
                address: token.address,
                name: token.name,
                volume, traders, liquidity, change5m, change24h
            };
            
            // Cek data terakhir di DB untuk evaluasi kondisi B (Surge)
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
                    // KONDISI A (Baru pertama kali alert)
                    conditionMet = true;
                    conditionType = "Baru (Kondisi A)";
                } else {
                    // KONDISI B (Surge Traders >= 50% atau Volume >= 100%, dan jeda > 5 menit)
                    const tradersSurge = lastTraders > 0 && (pToken.traders >= lastTraders * 1.5);
                    const volumeSurge = lastVolume > 0 && (pToken.volume >= lastVolume * 2.0);
                    
                    if ((tradersSurge || volumeSurge) && timeSinceLastAlert > fiveMinutes) {
                        conditionMet = true;
                        conditionType = "Surge (Kondisi B)";
                    }
                }
            }
            
            if (conditionMet) {
                pToken.conditionType = conditionType;
                passedTokens.push(pToken);
                
                // Update ke DB agar tidak ter-alert berulang kali sebelum 5 menit / update base metrics
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
                } catch (e) {
                    console.error("Gagal update token ke DB:", e.message);
                }
            }
        }
        
        console.log(`  ↳ 2.3 Ditemukan ${passedTokens.length} token lolos filter.`);
        console.log(`  ↳ 2.4 Mengirim ${passedTokens.length} token ke server Telegram...`);
        
        for (const t of passedTokens) {
            const msg = `🚀 *DexScreener Alert - ${t.conditionType}*\n\n` +
                        `*Token:* ${t.name}\n` +
                        `*Address:* \`${t.address}\`\n\n` +
                        `👥 Traders: ${t.traders}\n` +
                        `📊 Volume: $${t.volume}\n` +
                        `💧 Liquidity: $${t.liquidity}\n` +
                        `📈 5m Change: ${t.change5m}%\n` +
                        `📈 24h Change: ${t.change24h}%\n\n` +
                        `[🔗 View on DexScreener](https://dexscreener.com/solana/${t.address})`;
            
            // Kirim ke admin
            bot.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(console.error);
        }
        
        processSpinner.succeed('2. Mengolah data hasil scraping... (DONE)');
        
    } catch (e) {
        if (scrapeSpinner && scrapeSpinner.isSpinning) {
            scrapeSpinner.fail(`1. Bot melakukan web scraping... (FAILED: ${e.message})`);
        } else if (processSpinner && processSpinner.isSpinning) {
            processSpinner.fail(`2. Mengolah data hasil scraping... (FAILED: ${e.message})`);
        } else {
            console.error("\nTerjadi error pada siklus:", e.message);
        }
    } finally {
        // === MEMORY LEAK PREVENTION ===
        if (page) {
            await page.close().catch(() => {});
        }
        if (context) {
            await context.close().catch(() => {});
        }
        
        console.log("\n⏳ Menunggu jeda 1 menit...\n");
        // === ANTI-OVERLAPPING LOOP ===
        if (!isShuttingDown) {
            setTimeout(startScrapingCycle, 60000);
        }
    }
}

// === GRACEFUL SHUTDOWN (PM2) ===
const shutdown = async (signal) => {
    console.log(`\nMenerima sinyal ${signal}. Menutup proses dengan aman...`);
    isShuttingDown = true;
    
    if (globalBrowser) {
        await globalBrowser.close().catch(() => {});
        console.log("✅ Browser Playwright berhasil ditutup.");
    }
    
    try {
        await bot.stopPolling();
        console.log("✅ Polling Telegram dihentikan.");
    } catch(e) {
        console.error("Gagal stop polling Telegram:", e.message);
    }
    
    console.log("Exiting Node process...");
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// === INISIALISASI PROGRAM ===
async function init() {
    console.log("🚀 Inisialisasi Bot DexScreener dimulai...");
    
    // 1. Load config awal dari DB
    await loadConfigFromDB();
    console.log("✅ Config dimuat dari DB ke RAM:", currentFilter);
    
    // 2. Start global browser
    console.log("Membuka browser global Playwright...");
    globalBrowser = await chromium.launch({ headless: true });
    console.log("✅ Browser siap.");
    
    // 3. Mulai siklus 24/7
    console.log("\n=== MEMULAI SIKLUS SCRAPING 24/7 ===");
    startScrapingCycle();
}

init();
