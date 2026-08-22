/**
 * ═══════════════════════════════════════════════
 *  小机后端 server.js  (v2.3 — 思考链+记忆库)
 *  AI聊天代理 + 网易云音乐 + Gmail 集成 + 思考链 + 记忆库
 * ═══════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const CryptoJS = require('crypto-js');
const forge = require('node-forge');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Readable } = require('stream');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const musicSessions = new Map();

function musicCookie(req) {
  const id = req.headers['x-music-session'] || req.query.session;
  return id ? musicSessions.get(id) : null;
}

// ── 文件上传中间件（内存存储，不落盘） ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 静态文件 ──
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index-new.html')));

// ── 服务信息 ──
app.get('/api/server-info', (req, res) => {
  res.json({ ok: true, version: '2.3.0', time: new Date().toISOString() });
});

// The browser never sends an account password to this service. It sends a
// NetEase web-session cookie after the user signs in on music.163.com.
app.post('/api/music/session', async (req, res) => {
  const cookie = String(req.body.cookie || '').trim();
  if (!cookie || cookie.length < 20) return res.status(400).json({ error: '请输入有效的网易云网页登录 Cookie' });
  const sessionId = crypto.randomUUID();
  musicSessions.set(sessionId, cookie);
  res.json({ ok: true, sessionId });
});

app.delete('/api/music/session', (req, res) => {
  musicSessions.delete(req.headers['x-music-session']);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  文件上传 → 提取文字
// ═══════════════════════════════════════

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });

    const { originalname, buffer, mimetype, size } = req.file;
    const ext = (originalname.split('.').pop() || '').toLowerCase();

    let text = '';
    let fileType = 'text';

    if (ext === 'pdf' || mimetype === 'application/pdf') {
      fileType = 'pdf';
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const pdfData = await parser.getText();
      text = pdfData.text || '';
    } else if (ext === 'docx' || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      fileType = 'docx';
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';
    } else if (ext === 'doc' || mimetype === 'application/msword') {
      // .doc 旧格式，mammoth 不支持，尝试用 textract 或提示
      fileType = 'doc';
      // 简单提取：去掉二进制噪音，保留可读文本
      text = buffer.toString('latin1').replace(/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\n\r]/g, ' ').replace(/\s{3,}/g, '\n').trim();
      if (text.length < 20) {
        return res.json({ ok: false, error: '.doc 旧格式支持有限，建议另存为 .docx 后再上传', text: '', filename: originalname });
      }
    } else {
      // md, txt, json, csv, log, html, xml, yml 等纯文本
      fileType = ext || 'txt';
      text = buffer.toString('utf8');
    }

    // 截断超长文本（最多 50000 字符约 ~25000 汉字）
    const MAX_CHARS = 50000;
    let truncated = false;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
    }

    res.json({
      ok: true,
      filename: originalname,
      fileType,
      size,
      text,
      truncated,
      charCount: text.length
    });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: '文件解析失败: ' + e.message });
  }
});

// ═══════════════════════════════════════
//  网易云 weapi 加密
// ═══════════════════════════════════════
const NE_IV = '0102030405060708';
const NE_PRESET_KEY = '0CoJUm6Qyw8W8jud';
const NE_BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const NE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function neAesEncrypt(text, key) {
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(text),
    CryptoJS.enc.Utf8.parse(key),
    { iv: CryptoJS.enc.Utf8.parse(NE_IV), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
  );
  return encrypted.toString();
}

function neRsaEncrypt(str) {
  const pubKey = forge.pki.publicKeyFromPem(NE_PUBKEY);
  const encrypted = pubKey.encrypt(str, 'NONE');
  return forge.util.bytesToHex(encrypted);
}

function neWeapi(object) {
  const text = JSON.stringify(object);
  let secretKey = '';
  for (let i = 0; i < 16; i++) {
    secretKey += NE_BASE62.charAt(Math.round(Math.random() * 61));
  }
  return {
    params: neAesEncrypt(neAesEncrypt(text, NE_PRESET_KEY), secretKey),
    encSecKey: neRsaEncrypt(secretKey.split('').reverse().join(''))
  };
}

const NE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://music.163.com',
  'Content-Type': 'application/x-www-form-urlencoded'
};

// ═══════════════════════════════════════
//  AI 聊天代理
// ═══════════════════════════════════════
const AI_PROXY = process.env.AI_PROXY_URL || 'https://api.anthropic.com';

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, system, model, max_tokens, tools = [], thinking } = req.body;
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(400).json({ error: { message: '缺少 API Key' } });
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    // 思考链: 前端传 thinking={enabled:true} 时启用 extended thinking
    const thinkingConfig = thinking && thinking.enabled
      ? { thinking: { type: 'enabled', budget_tokens: Math.min(thinking.budget || 5000, 10000) } }
      : {};
    // 如果同时启用思考链和工具调用，需要 interleaved-thinking beta header
    if (thinkingConfig.thinking && tools.length) {
      headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }
    // 思考链模式下 max_tokens 需要更大
    const finalMaxTokens = thinkingConfig.thinking
      ? Math.max(max_tokens || 8000, 8000)
      : (max_tokens || 1000);
    const conversation = [...messages];
    const clientActions = [];

    // Complete a small server-side tool loop: the AI can search NetEase songs,
    // select one, and return an action for the browser to play on this device.
    for (let round = 0; round < 3; round++) {
      const resp = await fetch(`${AI_PROXY}/v1/messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: finalMaxTokens, system, messages: conversation, tools, ...thinkingConfig })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);
      const toolUses = (data.content || []).filter(block => block.type === 'tool_use');
      if (!toolUses.length) return res.json({ ...data, clientActions });

      conversation.push({ role: 'assistant', content: data.content });
      const toolResults = await Promise.all(toolUses.map(async tool => {
        try {
          if (tool.name === 'search_music') {
            const songs = await searchNeteaseMusic(tool.input.query, 5);
            return { type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(songs) };
          }
          if (tool.name === 'play_music') {
            const { songId, name, artist } = tool.input;
            if (!Number.isInteger(Number(songId))) throw new Error('无效歌曲 ID');
            clientActions.push({ type: 'play_music', songId: Number(songId), name: name || '未知歌曲', artist: artist || '' });
            return { type: 'tool_result', tool_use_id: tool.id, content: '已安排在用户当前设备的网页播放器中播放。' };
          }
          if (tool.name === 'edit_diary') {
            const { rawInput = '', diaryText, save = false } = tool.input;
            if (!diaryText) throw new Error('日记正文不能为空');
            clientActions.push({ type: 'edit_diary', rawInput, diaryText, save: Boolean(save) });
            return { type: 'tool_result', tool_use_id: tool.id, content: save ? '日记已写入并保存。' : '日记已写入编辑区，等待用户确认保存。' };
          }
          if (tool.name === 'compose_email') {
            const { to = '', subject = '', body } = tool.input;
            if (!body) throw new Error('邮件正文不能为空');
            clientActions.push({ type: 'compose_email', to, subject, body });
            return { type: 'tool_result', tool_use_id: tool.id, content: '邮件草稿已填入邮件页面，尚未发送，需用户点击发送。' };
          }
          throw new Error('不支持的工具');
        } catch (error) {
          return { type: 'tool_result', tool_use_id: tool.id, is_error: true, content: error.message };
        }
      }));
      conversation.push({ role: 'user', content: toolResults });
    }
    res.status(502).json({ error: { message: '工具调用次数过多，请重试' } });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

async function searchNeteaseMusic(query, limit = 20, cookie = '') {
  const q = String(query || '').trim();
  if (!q) throw new Error('缺少搜索词');
  const weapiData = neWeapi({ s: q, type: 1, offset: 0, limit: Math.min(Math.max(Number(limit) || 20, 1), 20), total: true });
  const resp = await fetch('https://music.163.com/weapi/search/get', { method: 'POST', headers: { ...NE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(weapiData).toString() });
  if (!resp.ok) throw new Error(`网易云搜索失败 (${resp.status})`);
  const data = await resp.json();
  return (data.result?.songs || []).map(s => ({ id: s.id, name: s.name, artist: (s.artists || []).map(a => a.name).join(' / '), album: s.album?.name || '' }));
}

// ═══════════════════════════════════════
//  网易云音乐
// ═══════════════════════════════════════

// 搜索歌曲
app.get('/api/music/search', async (req, res) => {
  try {
    const songs = await searchNeteaseMusic(req.query.q, parseInt(req.query.limit) || 20, musicCookie(req));
    res.json({ songs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取歌词
app.get('/api/music/lyric/:id', async (req, res) => {
  try {
    const weapiData = neWeapi({ id: req.params.id, lv: -1, tv: -1, kv: -1 });
    const resp = await fetch('https://music.163.com/weapi/song/lyric', {
      method: 'POST',
      headers: { ...NE_HEADERS, ...(musicCookie(req) ? { Cookie: musicCookie(req) } : {}) },
      body: new URLSearchParams(weapiData).toString()
    });
    const data = await resp.json();
    res.json({ lyric: data.lrc?.lyric || '', tlyric: data.tlyric?.lyric || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取歌曲播放URL
app.get('/api/music/url/:id', async (req, res) => {
  try {
    const songId = parseInt(req.params.id);
    const weapiData = neWeapi({
      ids: JSON.stringify([songId]),
      level: 'standard',
      encodeType: 'mp3',
      csrf_token: ''
    });
    const resp = await fetch('https://music.163.com/weapi/song/enhance/player/url/v1', {
      method: 'POST',
      headers: { ...NE_HEADERS, ...(musicCookie(req) ? { Cookie: musicCookie(req) } : {}) },
      body: new URLSearchParams(weapiData).toString()
    });
    const data = await resp.json();
    const songData = data.data?.[0];
    if (songData && songData.url) {
      res.json({ url: songData.url, type: songData.type || 'mp3', br: songData.br, size: songData.size, ok: true });
    } else {
      res.json({ url: null, ok: false, message: '无法获取播放链接（可能需要VIP或版权限制）' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 音频代理（解决跨域）
app.get('/api/music/stream/:id', async (req, res) => {
  try {
    const songId = parseInt(req.params.id);
    const weapiData = neWeapi({
      ids: JSON.stringify([songId]),
      level: 'standard',
      encodeType: 'mp3',
      csrf_token: ''
    });
    const resp = await fetch('https://music.163.com/weapi/song/enhance/player/url/v1', {
      method: 'POST',
      headers: { ...NE_HEADERS, ...(musicCookie(req) ? { Cookie: musicCookie(req) } : {}) },
      body: new URLSearchParams(weapiData).toString()
    });
    const data = await resp.json();
    const songData = data.data?.[0];
    if (!songData || !songData.url) {
      return res.status(404).json({ error: '无法获取播放链接' });
    }
    const headers = { 'User-Agent': NE_HEADERS['User-Agent'], 'Referer': 'https://music.163.com', ...(musicCookie(req) ? { Cookie: musicCookie(req) } : {}) };
    if (req.headers.range) headers.Range = req.headers.range;
    const audioResp = await fetch(songData.url, { headers });
    if (!audioResp.ok && audioResp.status !== 206) throw new Error(`音频源返回 ${audioResp.status}`);
    res.status(audioResp.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = audioResp.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!audioResp.body) return res.end();
    Readable.fromWeb(audioResp.body).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 调起本地客户端（仅桌面端有效，云部署返回提示）
app.post('/api/music/play', (req, res) => {
  const { songId } = req.body;
  if (!songId) return res.status(400).json({ error: '缺少 songId' });
  // 云端不支持本地客户端调起，返回 iframe 播放器地址供前端使用
  res.json({ ok: false, message: '云端部署不支持调起本地客户端，请使用浏览器内播放', iframe: `https://music.163.com/outchain/player?type=2&id=${songId}&auto=1&height=66` });
});

// ═══════════════════════════════════════
//  Gmail OAuth + 邮件
// ═══════════════════════════════════════

const GMAIL_CID = process.env.GMAIL_CLIENT_ID;
const GMAIL_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REDIRECT = process.env.GMAIL_REDIRECT_URI; // 留空则自动推断
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

// ── 内存存储 Gmail token（云部署文件系统是临时的） ──
let gmailTokenStore = GMAIL_REFRESH_TOKEN ? { refresh_token: GMAIL_REFRESH_TOKEN } : null;

// 根据请求来源动态生成回调URL
function getRedirectUri(req) {
  if (GMAIL_REDIRECT) return GMAIL_REDIRECT;
  const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/gmail/callback`;
}

// 只创建一个 OAuth2 客户端（支持动态 redirect）
function getOAuth2Client(req) {
  if (!GMAIL_CID || !GMAIL_SECRET) return null;
  const redirectUri = req ? getRedirectUri(req) : (GMAIL_REDIRECT || `http://localhost:${PORT}/api/gmail/callback`);
  return new google.auth.OAuth2(GMAIL_CID, GMAIL_SECRET, redirectUri);
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

function loadTokens() {
  return gmailTokenStore;
}

function saveTokens(tokens) {
  gmailTokenStore = tokens;
}

function getAuthedGmail(req) {
  const oAuth2 = getOAuth2Client(req);
  if (!oAuth2) return null;
  const tokens = loadTokens();
  if (!tokens) return null;
  oAuth2.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oAuth2 });
}

// 检查 Gmail 状态
app.get('/api/gmail/status', (req, res) => {
  const oAuth2 = getOAuth2Client(req);
  if (!oAuth2) return res.json({ configured: false, message: '未配置 Gmail Client ID/Secret' });
  const tokens = loadTokens();
  res.json({ configured: true, authorized: !!tokens });
});

// 发起 OAuth 授权
app.get('/api/gmail/auth', (req, res) => {
  const oAuth2 = getOAuth2Client(req);
  if (!oAuth2) return res.status(400).json({ error: '未配置 Gmail 凭据，请在环境变量设置 GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET' });
  const url = oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

// OAuth 回调
app.get('/api/gmail/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('缺少授权码');
  try {
    const oAuth2 = getOAuth2Client(req);
    const { tokens } = await oAuth2.getToken(code);
    saveTokens(tokens);
    res.send('<h1>授权成功！</h1><p>可以关闭此页面，回到小机了。</p><script>window.close()</script>');
  } catch (e) {
    res.status(500).send('授权失败: ' + e.message);
  }
});

// 读取邮件列表
app.get('/api/gmail/messages', async (req, res) => {
  try {
    const gmail = getAuthedGmail(req);
    if (!gmail) return res.status(400).json({ error: 'Gmail 未授权，请先访问 /api/gmail/auth' });
    const max = parseInt(req.query.max) || 10;
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: max });
    const ids = list.data.messages || [];
    const messages = await Promise.all(ids.slice(0, max).map(async m => {
      const detail = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From','To','Subject','Date'] });
      const h = {};
      (detail.data.payload?.headers || []).forEach(p => { h[p.name] = p.value; });
      return {
        id: m.id,
        from: h.From || '',
        to: h.To || '',
        subject: h.Subject || '(无主题)',
        date: h.Date || '',
        snippet: detail.data.snippet || ''
      };
    }));
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 读取单封邮件
app.get('/api/gmail/messages/:id', async (req, res) => {
  try {
    const gmail = getAuthedGmail(req);
    if (!gmail) return res.status(400).json({ error: 'Gmail 未授权' });
    const msg = await gmail.users.messages.get({ userId: 'me', id: req.params.id, format: 'full' });
    const h = {};
    (msg.data.payload?.headers || []).forEach(p => { h[p.name] = p.value; });
    let body = '';
    function extract(payload) {
      if (payload.body?.data) {
        body += Buffer.from(payload.body.data, 'base64').toString('utf8');
      }
      if (payload.parts) payload.parts.forEach(extract);
    }
    if (msg.data.payload) extract(msg.data.payload);
    res.json({
      id: req.params.id,
      from: h.From, to: h.To, subject: h.Subject, date: h.Date,
      body: body.slice(0, 20000)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 发送邮件
app.post('/api/gmail/send', async (req, res) => {
  try {
    const gmail = getAuthedGmail(req);
    if (!gmail) return res.status(400).json({ error: 'Gmail 未授权' });
    const { to, subject, body } = req.body;
    if (!to || !subject) return res.status(400).json({ error: '缺少收件人或主题' });
    const raw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body || ''
    ].join('\r\n');
    const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded }
    });
    res.json({ ok: true, id: result.data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI 起草并发送邮件
app.post('/api/gmail/draft-and-send', async (req, res) => {
  try {
    const gmail = getAuthedGmail(req);
    if (!gmail) return res.status(400).json({ error: 'Gmail 未授权' });
    const { to, subject, instruction, memory, readyToSend = false } = req.body;
    const apiKey = req.headers['x-api-key'] || req.body.apiKey;
    if (!to || !instruction) return res.status(400).json({ error: '缺少收件人或写信意图' });
    if (!apiKey) return res.status(400).json({ error: '缺少 AI API Key，请先在设置中填写' });

    let emailBody = instruction;
    if (!readyToSend) {
      const sys = `你是小机，正在帮用户写一封邮件。根据用户的描述，用得体、自然的中文写邮件正文。直接输出邮件正文HTML，不加标题、不加解释、不要写"收件人"等抬头。语气根据用户描述调整。`;
      const userMsg = `收件人：${to}\n主题：${subject || '(由你拟定)'}\n用户的写信意图：${instruction}${memory ? '\n\n用户信息：' + memory : ''}`;
      const aiResp = await fetch(`${AI_PROXY}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, system: sys, messages: [{ role: 'user', content: userMsg }] }) });
      const aiData = await aiResp.json();
      if (!aiResp.ok) return res.status(aiResp.status).json(aiData);
      emailBody = aiData.content?.[0]?.text;
    }
    if (!emailBody) return res.status(502).json({ error: 'AI 未返回邮件正文' });
    const finalSubject = subject || '来自小机的邮件';

    const raw = [
      `To: ${to}`,
      `Subject: ${finalSubject}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      emailBody
    ].join('\r\n');
    const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded }
    });
    res.json({ ok: true, id: result.data.id, body: emailBody, subject: finalSubject });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
//  聊天记录云同步（通过 Supabase 代理）
// ═══════════════════════════════════════

// 上传聊天记录到云端
app.post('/api/chat/sync', async (req, res) => {
  try {
    const { syncCode, messages, deviceName, sbUrl, sbKey } = req.body;
    if (!syncCode) return res.status(400).json({ error: '缺少同步码' });
    if (!sbUrl || !sbKey) return res.status(400).json({ error: '缺少 Supabase 配置' });

    const resp = await fetch(`${sbUrl}/rest/v1/chat_history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        sync_code: syncCode,
        messages: messages,
        device_name: deviceName || 'unknown',
        updated_at: new Date().toISOString()
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `Supabase 错误: ${errText.slice(0, 200)}` });
    }
    res.json({ ok: true, message: '已同步到云端', count: messages.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从云端拉取聊天记录
app.get('/api/chat/sync', async (req, res) => {
  try {
    const syncCode = req.query.code;
    const sbUrl = req.query.sbUrl;
    const sbKey = req.query.sbKey;
    if (!syncCode) return res.status(400).json({ error: '缺少同步码' });
    if (!sbUrl || !sbKey) return res.status(400).json({ error: '缺少 Supabase 配置' });

    const resp = await fetch(
      `${sbUrl}/rest/v1/chat_history?sync_code=eq.${encodeURIComponent(syncCode)}&select=messages,updated_at,device_name&order=updated_at.desc&limit=1`,
      {
        headers: {
          'apikey': sbKey,
          'Authorization': `Bearer ${sbKey}`
        }
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `Supabase 错误: ${errText.slice(0, 200)}` });
    }
    const data = await resp.json();
    if (!data.length) return res.json({ ok: false, message: '云端无数据' });
    res.json({ ok: true, messages: data[0].messages, updated_at: data[0].updated_at, device_name: data[0].device_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
//  对话总结（提取记忆）
// ═══════════════════════════════════════
app.post('/api/summarize', async (req, res) => {
  try {
    const { messages, sessionTitle, memory } = req.body;
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(400).json({ error: { message: '缺少 API Key' } });
    if (!messages || !messages.length) return res.status(400).json({ error: { message: '缺少对话内容' } });

    // 构建对话摘要文本
    const dialogText = messages.map(m => {
      const role = m.role === 'user' ? '用户' : '小机';
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.map(c => {
          if (c.type === 'image') return '[图片]';
          if (c.type === 'text') return c.text;
          return '';
        }).join(' ');
      }
      return `${role}：${content}`;
    }).join('\n\n');

    const sys = `你是一个记忆提取助手。请分析以下对话，提取出关键的记忆点，包括：
1. 用户的个人信息（名字、偏好、习惯、工作等）
2. 重要的对话主题和结论
3. 用户表达的情绪和态度
4. 任何值得长期记住的事实

请用简洁的条目格式输出，每条一行，总共不超过 15 条。不要输出多余的解释。
格式示例：
- 用户喜欢听周杰伦的歌
- 用户在工作中遇到压力时会主动倾诉
- 用户养了一只叫"团子"的猫`;

    let userMsg = `对话标题：${sessionTitle || '未命名对话'}\n\n以下是对话内容：\n\n${dialogText}`;
    if (memory) userMsg += `\n\n已有的用户记忆：${memory}`;

    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    const resp = await fetch(`${AI_PROXY}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1500, system: sys,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    const summary = data.content?.[0]?.text || '';
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
//  记忆库云同步
// ═══════════════════════════════════════
app.post('/api/memory/sync', async (req, res) => {
  try {
    const { syncCode, memories, sbUrl, sbKey } = req.body;
    if (!syncCode) return res.status(400).json({ error: '缺少同步码' });
    if (!sbUrl || !sbKey) return res.status(400).json({ error: '缺少 Supabase 配置' });

    const resp = await fetch(`${sbUrl}/rest/v1/memory_bank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        sync_code: syncCode,
        memories: memories,
        updated_at: new Date().toISOString()
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `Supabase: ${errText.slice(0, 200)}` });
    }
    res.json({ ok: true, count: memories.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/memory/sync', async (req, res) => {
  try {
    const syncCode = req.query.code;
    const sbUrl = req.query.sbUrl;
    const sbKey = req.query.sbKey;
    if (!syncCode) return res.status(400).json({ error: '缺少同步码' });
    if (!sbUrl || !sbKey) return res.status(400).json({ error: '缺少 Supabase 配置' });

    const resp = await fetch(
      `${sbUrl}/rest/v1/memory_bank?sync_code=eq.${encodeURIComponent(syncCode)}&select=memories,updated_at&order=updated_at.desc&limit=1`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `Supabase: ${errText.slice(0, 200)}` });
    }
    const data = await resp.json();
    if (!data.length) return res.json({ ok: false, message: '云端无记忆' });
    res.json({ ok: true, memories: data[0].memories, updated_at: data[0].updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
//  启动
// ═══════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║  小机 v2.3 已启动 :${PORT}          ║`);
  console.log(`  ║  http://localhost:${PORT}          ║`);
  console.log(`  ╚══════════════════════════════════╝`);
  if (!GMAIL_CID) {
    console.log('\n  ⚠ Gmail 未配置');
    console.log('    请设置环境变量 GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET\n');
  } else {
    console.log('  Gmail 已配置，授权后可用\n');
  }
});
