'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, Notification } = require('electron');
const path = require('path');
const cron = require('node-cron');
const Store = require('electron-store');

// Only load updater in packaged app — not during dev (npm start)
const isDev = !app.isPackaged;
const updater = isDev ? null : require('./updater');

// ── Persistent config store (replaces .env file) ──────────────────────────────
const store = new Store({
  name: 'restockbot-config',
  defaults: {
    settings: {
      emailEnabled: false,
      emailFrom: '',
      emailTo: '',
      emailPass: '',
      smsEnabled: false,
      twilioSid: '',
      twilioToken: '',
      twilioFrom: '',
      twilioTo: '',
      checkInterval: '*/5 * * * *',
      useBrowser: false,
      dryRun: true,
      requireConfirm: true,
      dashboardPort: 3000,
      webhookEnabled: false,
      webhookRestockUrl: '',
      webhookOrderUrl: ''
    },
    watchlist: [],
    activityLog: [],
    setupComplete: false
  }
});

let mainWindow = null;
let tray = null;
let cronJob = null;
let isRunning = false;

// ── Window creation ────────────────────────────────────────────────────────────

function createWindow() {
  const setupDone = store.get('setupComplete');

  mainWindow = new BrowserWindow({
    width: setupDone ? 1100 : 560,
    height: setupDone ? 720 : 680,
    minWidth: setupDone ? 900 : 560,
    minHeight: setupDone ? 600 : 680,
    resizable: true,
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  });

  const page = setupDone ? 'dashboard' : 'setup';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', `${page}.html`));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (isRunning) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── System Tray ────────────────────────────────────────────────────────────────

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-icon.png'));
  tray = new Tray(img.resize({ width: 16, height: 16 }));

  const updateMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: 'RestockBot', enabled: false },
      { type: 'separator' },
      { label: isRunning ? '● Monitoring active' : '○ Bot stopped', enabled: false },
      { type: 'separator' },
      { label: 'Open Dashboard', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { label: isRunning ? 'Stop Bot' : 'Start Bot', click: () => isRunning ? stopBot() : startBot() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isRunning = false; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
  };

  tray.setToolTip('RestockBot — monitoring active');
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
  updateMenu();
  return updateMenu;
}

// ── Bot engine ─────────────────────────────────────────────────────────────────

function startBot() {
  if (isRunning) return;
  const settings = store.get('settings');
  const interval = settings.checkInterval || '*/5 * * * *';

  log('info', `Bot started — checking on schedule: ${interval}`);
  isRunning = true;

  // Run immediately
  runChecks();

  // Then on schedule
  cronJob = cron.schedule(interval, runChecks);

  mainWindow?.webContents.send('bot-status', { running: true });
}

function stopBot() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  isRunning = false;
  log('info', 'Bot stopped.');
  mainWindow?.webContents.send('bot-status', { running: false });
}

async function runChecks() {
  const watchlist = store.get('watchlist') || [];
  const enabled = watchlist.filter(i => i.enabled !== false);
  if (!enabled.length) return;

  log('info', `Running checks on ${enabled.length} item(s)...`);

  for (const item of enabled) {
    try {
      const result = await checkItem(item);
      const now = new Date().toISOString();
      const wasOut = !item.lastStatus || item.lastStatus === 'out' || item.lastStatus === 'unknown';

      // Save price + history if scraped
      const priceUpdate = {};
      if (result.price != null) {
        priceUpdate.lastPrice = result.price;
        const history = item.priceHistory || [];
        history.push({ price: result.price, ts: now });
        priceUpdate.priceHistory = history.slice(-50); // keep last 50 data points
      }

      const statusHistory = item.statusHistory || [];
      statusHistory.push(result.inStock ? 'in' : 'out');

      updateItemInStore(item.id, {
        lastStatus: result.inStock ? 'in' : 'out',
        lastChecked: now,
        timesChecked: (item.timesChecked || 0) + 1,
        statusHistory: statusHistory.slice(-20),
        ...priceUpdate
      });

      if (result.error) {
        log('warn', `[${item.name}] ${result.error}`);
        continue;
      }

      // Price gate check
      const pm = item.priceMonitor;
      let priceGatePass = true;
      let priceMsg = '';
      if (pm?.enabled && pm?.targetPrice != null) {
        if (result.price == null) {
          priceMsg = `(price not found — set a price selector in item settings)`;
          priceGatePass = false;
        } else if (result.price > pm.targetPrice) {
          priceMsg = `(price $${result.price.toFixed(2)} above target $${pm.targetPrice.toFixed(2)} — scalper/third party detected, skipping)`;
          priceGatePass = false;
        } else {
          priceMsg = `(price $${result.price.toFixed(2)} ✓ at or below target $${pm.targetPrice.toFixed(2)})`;
        }
      }

      const stockMsg = result.inStock ? 'IN STOCK' : 'out of stock';
      const priceLog = result.price != null ? ` | price: $${result.price.toFixed(2)}` : '';
      log('info', `[${item.name}] → ${stockMsg}${priceLog} ${priceMsg}`);

      if (result.inStock && wasOut && priceGatePass) {
        const alertMsg = pm?.enabled && result.price != null
          ? `${item.name} is back in stock at $${result.price.toFixed(2)}!`
          : `${item.name} is back in stock!`;

        log('info', `★ RESTOCK DETECTED: ${alertMsg}`);
        const restockEntry = { ts: now, price: result.price || null };
        const restockHistory = item.restockHistory || [];
        restockHistory.push(restockEntry);
        updateItemInStore(item.id, {
          timesRestocked: (item.timesRestocked || 0) + 1,
          restockHistory: restockHistory.slice(-100)
        });

        // Desktop notification
        showNotification(alertMsg, item.url);

        // Email/SMS
        await sendNotifications(item, result.price);

        // Auto-order
        if (item.autoOrder?.enabled) {
          await handleAutoOrder(item);
        }

        mainWindow?.webContents.send('restock-detected', { item });
      } else if (result.inStock && wasOut && !priceGatePass) {
        log('warn', `[${item.name}] In stock but ${priceMsg} — not alerting`);
      }

      await sleep(1200);
    } catch (err) {
      log('error', `[${item.name}] ${err.message}`);
    }
  }

  mainWindow?.webContents.send('checks-complete', { watchlist: store.get('watchlist') });
}

// ── Stock checker ──────────────────────────────────────────────────────────────

async function checkItem(item) {
  const settings = store.get('settings') || {};
  const useBrowser = settings.useBrowser === true;

  // Use Puppeteer for JS-heavy sites when browser mode is on
  if (useBrowser) {
    return await checkItemBrowser(item);
  }
  return await checkItemAxios(item);
}

async function checkItemAxios(item) {
  const axios = require('axios');
  const cheerio = require('cheerio');
  try {
    const resp = await axios.get(item.url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    return parseStockFromHtml(resp.data, item);
  } catch (err) {
    return { inStock: null, error: err.message };
  }
}

async function checkItemBrowser(item) {
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(45000);

    await page.goto(item.url, { waitUntil: 'networkidle2', timeout: 45000 });

    // Extra wait for JS-rendered content
    await new Promise(r => setTimeout(r, 2500));

    const html = await page.content();
    return parseStockFromHtml(html, item);
  } catch (err) {
    return { inStock: null, error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function parseStockFromHtml(html, item) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const sel = item.check?.selector;
  const kw = (item.check?.keyword || 'Add to Cart').toLowerCase();
  const oos = (item.check?.outOfStockText || '').toLowerCase();

  // ── Stock detection ──
  let inStock = false;
  if (sel && sel !== 'body') {
    const el = $(sel);
    if (!el.length) return { inStock: null, error: `Selector "${sel}" not found on page` };
    const txt = el.text().trim().toLowerCase();
    if (oos && txt.includes(oos)) { inStock = false; }
    else if (txt.includes(kw)) { inStock = true; }
    else { inStock = false; }
  } else {
    const body = $('body').text().toLowerCase();
    if (oos && body.includes(oos)) { inStock = false; }
    else if (body.includes(kw)) { inStock = true; }
    else { inStock = false; }
  }

  // ── Price scraping ──
  let scrapedPrice = null;
  if (item.priceMonitor?.enabled) {
    scrapedPrice = scrapePrice($, item.priceMonitor?.priceSelector);
  }

  return { inStock, price: scrapedPrice };
}

// Price selectors to try in order — covers most major retailers
const PRICE_SELECTORS = [
  // Explicit selector from item config (first priority)
  // Common structured data
  '[itemprop="price"]',
  '[data-price]',
  '[data-testid*="price"]',
  '[data-automation*="price"]',
  // Retailer-specific
  '.price-characteristic',        // Walmart
  '.price__sale',                  // Shopify
  '.a-price .a-offscreen',        // Amazon
  '.product-price',
  '.price-box .price',
  '.pdp-price',
  '.product__price',
  '.product-info-price .price',
  '[class*="ProductPrice"]',
  '[class*="product-price"]',
  '[class*="PriceDisplay"]',
  '[class*="price-display"]',
  '.price',
  '#price',
  'span[class*="price"]',
  'div[class*="price"]',
];

function scrapePrice($, customSelector) {
  const selectors = customSelector
    ? [customSelector, ...PRICE_SELECTORS]
    : PRICE_SELECTORS;

  for (const sel of selectors) {
    try {
      const el = $(sel).first();
      if (!el.length) continue;

      // Check data-price attribute first (Walmart uses this)
      const dataPrice = el.attr('data-price') || el.attr('content');
      if (dataPrice) {
        const p = parseFloat(dataPrice.replace(/[^0-9.]/g, ''));
        if (!isNaN(p) && p > 0) return p;
      }

      // Otherwise parse text
      const txt = el.text().trim();
      // Strip currency symbols, keep first valid price (handles "Was $50 Now $29.99")
      const matches = txt.match(/\$?([0-9]+(?:\.[0-9]{1,2})?)/g);
      if (matches && matches.length > 0) {
        // If multiple prices (was/now), take the LOWEST (most likely current)
        const prices = matches
          .map(m => parseFloat(m.replace('$', '')))
          .filter(p => !isNaN(p) && p > 0);
        if (prices.length > 0) return Math.min(...prices);
      }
    } catch(e) { continue; }
  }
  return null;
}

// ── Auto-order ─────────────────────────────────────────────────────────────────

async function handleAutoOrder(item) {
  const settings = store.get('settings');
  if (settings.dryRun) { log('info', `[DRY RUN] Would order: ${item.name}`); return; }
  if (settings.requireConfirm) { log('warn', `[Order] Confirmation required for: ${item.name} — enable in Settings`); return; }

  const axios = require('axios');
  const ao = item.autoOrder;
  try {
    const resp = await axios.post(ao.cartUrl, { ...ao.cartPayload, quantity: ao.quantity || 1 }, { timeout: 15000 });
    if (resp.status >= 200 && resp.status < 300) {
      log('info', `[Order] ✅ Placed for ${item.name}`);
      updateItemInStore(item.id, { ordersPlaced: (item.ordersPlaced || 0) + 1 });
      showNotification(`Order placed for ${item.name}!`, 'Check your email for confirmation.');
    }
  } catch (err) {
    log('error', `[Order] Failed for ${item.name}: ${err.message}`);
  }
}

// ── Notifications ──────────────────────────────────────────────────────────────

function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title: `RestockBot: ${title}`, body, silent: false }).show();
  }
}

async function sendNotifications(item, price) {
  const s = store.get('settings');

  // ── Email ──
  if (s.emailEnabled && item.notify?.email !== false && s.emailFrom && s.emailPass) {
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({ service: 'gmail', auth: { user: s.emailFrom, pass: s.emailPass } });
      const priceHtml = price != null ? `<br><b>Price: $${price.toFixed(2)}</b>` : '';
      const targetHtml = item.priceMonitor?.targetPrice != null
        ? `<br>Your target price: $${parseFloat(item.priceMonitor.targetPrice).toFixed(2)}` : '';
      await t.sendMail({
        from: `RestockBot <${s.emailFrom}>`, to: s.emailTo || s.emailFrom,
        subject: `[RestockBot] ${item.name} is back in stock${price != null ? ` at $${price.toFixed(2)}` : ''}!`,
        html: `<b>${item.name}</b> is back in stock!${priceHtml}${targetHtml}<br><br><a href="${item.url}" style="background:#00e5c8;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">View Product →</a>`
      });
      log('info', `Email alert sent for: ${item.name}`);
    } catch (err) { log('error', `Email failed: ${err.message}`); }
  }

  // ── Discord webhook ──
  const discordUrl = item.discordWebhook || (s.discordEnabled ? s.discordWebhook : null);
  if (discordUrl && item.notify?.discord !== false) {
    try {
      const axios = require('axios');
      const priceStr = price != null ? ` at **$${price.toFixed(2)}**` : '';
      const targetStr = item.priceMonitor?.targetPrice ? ` (target: $${parseFloat(item.priceMonitor.targetPrice).toFixed(2)})` : '';
      const embed = {
        embeds: [{
          title: '🟢 RESTOCK DETECTED',
          description: `**${item.name}** is back in stock${priceStr}${targetStr}`,
          color: 0x00e5a0,
          fields: [
            { name: 'Retailer', value: item.url.split('/')[2]?.replace('www.','') || 'Unknown', inline: true },
            ...(price != null ? [{ name: 'Price', value: `$${price.toFixed(2)}`, inline: true }] : []),
            ...(item.priceMonitor?.targetPrice ? [{ name: 'Your Target', value: `$${parseFloat(item.priceMonitor.targetPrice).toFixed(2)}`, inline: true }] : []),
          ],
          url: item.url,
          footer: { text: 'RestockBot' },
          timestamp: new Date().toISOString()
        }],
        components: [{
          type: 1,
          components: [{ type: 2, style: 5, label: 'View Product →', url: item.url }]
        }]
      };
      await axios.post(discordUrl, embed, { timeout: 8000 });
      log('info', `Discord alert sent for: ${item.name}`);
    } catch (err) { log('error', `Discord webhook failed: ${err.message}`); }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(level, message) {
  const entry = { timestamp: new Date().toISOString(), level, message };
  const logs = store.get('activityLog') || [];
  logs.unshift(entry);
  store.set('activityLog', logs.slice(0, 500));
  mainWindow?.webContents.send('log-entry', entry);
}

function updateItemInStore(id, updates) {
  const list = store.get('watchlist') || [];
  const idx = list.findIndex(i => i.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...updates };
  store.set('watchlist', list);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── IPC Handlers (renderer <-> main) ──────────────────────────────────────────

ipcMain.handle('get-store', (_, key) => store.get(key));
ipcMain.handle('set-store', (_, key, value) => { store.set(key, value); return true; });

ipcMain.handle('start-bot', () => { startBot(); return true; });
ipcMain.handle('stop-bot', () => { stopBot(); return true; });
ipcMain.handle('check-now', async (_, itemId) => {
  const item = (store.get('watchlist') || []).find(i => i.id === itemId);
  if (!item) return { error: 'Not found' };
  const result = await checkItem(item);
  const now = new Date().toISOString();
  const priceUpdate = {};
  if (result.price != null) {
    priceUpdate.lastPrice = result.price;
    const history = item.priceHistory || [];
    history.push({ price: result.price, ts: now });
    priceUpdate.priceHistory = history.slice(-50);
  }
  updateItemInStore(itemId, {
    lastStatus: result.inStock ? 'in' : 'out',
    lastChecked: now,
    timesChecked: (item.timesChecked || 0) + 1,
    ...priceUpdate
  });
  return result;
});

ipcMain.handle('complete-setup', (_, settings) => {
  store.set('settings', settings);
  store.set('setupComplete', true);

  // Resize to full dashboard dimensions
  mainWindow.setResizable(true);
  mainWindow.setSize(1100, 720);
  mainWindow.setMinimumSize(900, 600);
  mainWindow.center();

  // Navigate to dashboard
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard.html'));

  // Start bot once dashboard has loaded
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => startBot(), 800);
  });

  return true;
});

ipcMain.handle('reset-setup', () => {
  store.set('setupComplete', false);
  stopBot();
  mainWindow.setSize(560, 680);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
  return true;
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
ipcMain.handle('get-bot-status', () => isRunning);

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close', () => isRunning ? mainWindow?.hide() : app.quit());
ipcMain.on('window-quit', () => { isRunning = false; app.quit(); });

// ── Updater IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('check-for-updates', () => {
  if (updater) updater.checkForUpdates();
  else return { status: 'dev-mode' };
});
ipcMain.handle('install-update', () => {
  if (updater) updater.installNow();
});
ipcMain.handle('get-app-version', () => app.getVersion());

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  const updateTrayMenu = createTray();

  // Auto-start bot if setup is done
  if (store.get('setupComplete')) {
    setTimeout(() => {
      startBot();
      updateTrayMenu();
    }, 1500);
  }

  // Start auto-updater (only in packaged app, not dev)
  if (updater) {
    mainWindow.webContents.once('did-finish-load', () => {
      updater.init(mainWindow);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (!isRunning) app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});
