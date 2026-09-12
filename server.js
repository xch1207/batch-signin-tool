/**
 * 批量签到工具 - 本地代理服务
 * 零外部依赖，仅使用 Node.js 内置模块
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ========== 配置加载 ==========
const CONFIG_PATH = path.join(__dirname, 'config.json');
let CONFIG = {
    port: 17888,
    accessPassword: '',
    targetHost: 'xjskp.x1j2s3k4p.lol',
    targetPort: 6688,
    defaultDelay: 1500
};

try {
    if (fs.existsSync(CONFIG_PATH)) {
        const userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        CONFIG = { ...CONFIG, ...userConfig };
    }
} catch (e) {
    console.warn('[警告] config.json 解析失败，使用默认配置:', e.message);
}

// ========== 目标站点配置 ==========
const TARGET_HOST = CONFIG.targetHost;
const TARGET_PORT = CONFIG.targetPort;
const TARGET_BASE = `https://${TARGET_HOST}:${TARGET_PORT}`;
const PORT = process.env.PORT || CONFIG.port;
const ACCESS_PASSWORD = CONFIG.accessPassword || '';

// ========== 访问令牌（简易鉴权） ==========
const activeTokens = new Set();
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24小时

function generateToken() {
    return crypto.randomBytes(24).toString('hex');
}

function verifyToken(req) {
    if (!ACCESS_PASSWORD) return true; // 未设密码，不校验
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    return token && activeTokens.has(token);
}

function cleanupExpiredTokens() {
    // 简单清理：令牌数量过多时清空（实际项目可用带时间戳的Map）
    if (activeTokens.size > 1000) activeTokens.clear();
}
setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

// ========== HTTP 请求封装 ==========

/**
 * 向目标站点发送 POST 请求（form-urlencoded）
 * @param {string} pathname - 请求路径
 * @param {object} data - 表单数据
 * @param {string} cookies - 要携带的 Cookie 字符串
 * @param {boolean} followRedirect - 是否自动跟随重定向（默认true）
 * @param {number} redirectCount - 重定向计数（内部使用）
 * @param {string[]} collectedCookies - 收集的所有 Set-Cookie（内部使用）
 * @returns {Promise<{body: string, setCookie: string[], status: number, headers: object}>}
 */
function postForm(pathname, data, cookies = '', followRedirect = true, redirectCount = 0, collectedCookies = []) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('重定向次数过多'));
            return;
        }

        const postData = new URLSearchParams(data).toString();
        const options = {
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: pathname,
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': TARGET_BASE + '/pay/login',
                'Accept': 'application/json, text/plain, */*',
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        };

        const req = https.request(options, (res) => {
            // 收集此响应的 Set-Cookie
            const respCookies = res.headers['set-cookie'] || [];
            const allCookies = [...collectedCookies, ...respCookies];

            // 处理重定向
            const status = res.statusCode;
            const location = res.headers['location'];
            if (status >= 300 && status < 400 && location) {
                // 如果不跟随重定向，直接返回重定向响应
                if (!followRedirect) {
                    res.resume();
                    resolve({
                        body: '',
                        setCookie: allCookies,
                        status: status,
                        headers: res.headers,
                        redirectUrl: location
                    });
                    return;
                }

                // 消耗响应体（必须，否则连接不会释放）
                res.resume();

                // 合并当前已有的 Cookie 和重定向响应的 Cookie
                let currentCookies = cookies;
                const newCookies = mergeCookies(respCookies);
                if (newCookies) currentCookies = newCookies;

                // 解析重定向 URL
                let redirectPath = location;
                if (location.startsWith('http')) {
                    try {
                        const u = new URL(location);
                        redirectPath = u.pathname + u.search;
                    } catch (e) {
                        redirectPath = location;
                    }
                }

                // 303 改为 GET，其他保持 POST
                if (status === 303) {
                    getPage(redirectPath, currentCookies, redirectCount + 1, allCookies)
                        .then(resolve)
                        .catch(reject);
                } else {
                    postForm(redirectPath, data, currentCookies, true, redirectCount + 1, allCookies)
                        .then(resolve)
                        .catch(reject);
                }
                return;
            }

            // 非重定向，读取响应体
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                resolve({
                    body,
                    setCookie: allCookies,
                    status: status,
                    headers: res.headers
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(new Error('请求超时')); });
        req.write(postData);
        req.end();
    });
}

/**
 * 向目标站点发送 GET 请求，自动跟随重定向
 * @param {string} pathname - 请求路径
 * @param {string} cookies - 要携带的 Cookie
 * @param {number} redirectCount - 重定向计数（内部使用）
 * @param {string[]} collectedCookies - 收集的所有 Set-Cookie（内部使用）
 * @returns {Promise<{body: string, setCookie: string[], status: number}>}
 */
function getPage(pathname, cookies = '', redirectCount = 0, collectedCookies = []) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('重定向次数过多'));
            return;
        }

        const options = {
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: pathname,
            method: 'GET',
            rejectUnauthorized: false,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': TARGET_BASE + '/pay/Home.html',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        };

        const req = https.request(options, (res) => {
            const respCookies = res.headers['set-cookie'] || [];
            const allCookies = [...collectedCookies, ...respCookies];

            const status = res.statusCode;
            const location = res.headers['location'];
            if (status >= 300 && status < 400 && location) {
                res.resume();

                let currentCookies = cookies;
                const newCookies = mergeCookies(respCookies);
                if (newCookies) currentCookies = newCookies;

                let redirectPath = location;
                if (location.startsWith('http')) {
                    try {
                        const u = new URL(location);
                        redirectPath = u.pathname + u.search;
                    } catch (e) {
                        redirectPath = location;
                    }
                }

                getPage(redirectPath, currentCookies, redirectCount + 1, allCookies)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                resolve({
                    body,
                    setCookie: allCookies,
                    status: status
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(new Error('请求超时')); });
        req.end();
    });
}

/**
 * 合并 Set-Cookie 头，提取有效的 cookie 字符串
 */
function mergeCookies(setCookieList) {
    const cookies = {};
    for (const sc of setCookieList) {
        const pair = sc.split(';')[0];
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
            const key = pair.substring(0, eqIdx).trim();
            const val = pair.substring(eqIdx + 1).trim();
            if (key && val) cookies[key] = val;
        }
    }
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ========== 核心业务逻辑 ==========

/**
 * 单个账号的登录 + 签到流程
 * @param {object} acc - { account, pwd, serverid }
 * @returns {Promise<object>} 签到结果
 */
async function loginAndSignin(acc) {
    const { account, pwd, serverid } = acc;
    const serverNames = ['一区', '二区', '三区', '四区', '五区', '六区', '七区'];
    const serverName = serverNames[parseInt(serverid) - 1] || `${serverid}区`;

    // ---- 第0步：先访问登录页，获取初始 Cookie ----
    let cookies = '';
    try {
        const loginPageRes = await getPage('/pay/login');
        const initialCookies = mergeCookies(loginPageRes.setCookie);
        if (initialCookies) cookies = initialCookies;
    } catch (e) {
        // 登录页访问失败不阻断，继续尝试登录
    }

    // ---- 第1步：登录（不跟随重定向，以便检测302状态） ----
    let loginRes;
    try {
        loginRes = await postForm('/pay/Login/index', { account, pwd, serverid }, cookies, false);
    } catch (e) {
        return { account, serverid, serverName, success: false, stage: 'login', msg: `网络错误: ${e.message}` };
    }

    // 合并登录响应的 Cookie
    const loginCookies = mergeCookies(loginRes.setCookie);
    if (loginCookies) cookies = loginCookies;

    // 判断登录结果：302重定向 或 JSON响应
    let redirectUrl = null;
    const loginStatus = loginRes.status;

    // 情况1：302/301重定向 = 登录成功
    if (loginStatus >= 300 && loginStatus < 400 && loginRes.redirectUrl) {
        redirectUrl = loginRes.redirectUrl;
    }
    // 情况2：JSON响应
    else {
        const bodyTrimmed = loginRes.body.trim();
        let loginData = null;
        if (bodyTrimmed.startsWith('{') || bodyTrimmed.startsWith('[')) {
            try {
                loginData = JSON.parse(bodyTrimmed);
            } catch {
                loginData = null;
            }
        }

        if (!loginData) {
            // 非 JSON 响应
            let errMsg;
            if (bodyTrimmed.length === 0) {
                errMsg = `登录响应为空（HTTP ${loginStatus}），账号可能被限制或需要验证码`;
            } else if (bodyTrimmed.includes('<html') || bodyTrimmed.includes('<HTML') || bodyTrimmed.includes('<!DOCTYPE')) {
                errMsg = '登录返回了HTML页面，可能需要验证码或账号被限制';
            } else {
                // 纯文本错误信息（如"账号密码错误"）
                errMsg = bodyTrimmed.substring(0, 200);
            }
            return { account, serverid, serverName, success: false, stage: 'login', msg: errMsg };
        }

        if (loginData.code !== 0) {
            return { account, serverid, serverName, success: false, stage: 'login', msg: loginData.msg || '登录失败' };
        }

        // JSON登录成功，获取跳转URL
        if (loginData.url) {
            redirectUrl = loginData.url;
        }
    }

    // ---- 第2步：访问登录跳转页，完善会话（Cookie 可能在这里设置） ----
    if (redirectUrl) {
        try {
            const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : TARGET_BASE + redirectUrl;
            const redirectPath = new URL(fullUrl).pathname + (new URL(fullUrl).search || '');
            const homeRes = await getPage(redirectPath, cookies);
            // 合并新的 Cookie
            const newCookies = mergeCookies(homeRes.setCookie);
            if (newCookies) cookies = newCookies;
        } catch (e) {
            // 跳转页访问失败不阻断流程，继续尝试签到
        }
    }

    // 登录跳转后检查是否有会话 Cookie
    if (!cookies) {
        return { account, serverid, serverName, success: false, stage: 'login', msg: '登录成功但未获取到会话 Cookie，请检查账号状态' };
    }

    // ---- 第3步：访问签到页，确保角色已加载 ----
    try {
        const signinPageRes = await getPage('/pay/signin.html', cookies);
        const newCookies = mergeCookies(signinPageRes.setCookie);
        if (newCookies) cookies = newCookies;
    } catch (e) {
        // 签到页访问失败不阻断
    }

    // ---- 第4步：执行签到 ----
    let signinRes;
    try {
        signinRes = await postForm('/pay/signin/doSignin', {}, cookies);
    } catch (e) {
        return { account, serverid, serverName, success: false, stage: 'signin', msg: `签到网络错误: ${e.message}` };
    }

    // 解析签到响应（可能是 JSON，也可能是纯文本）
    let signinData = null;
    const signinBody = signinRes.body.trim();
    if (signinBody.startsWith('{') || signinBody.startsWith('[')) {
        try {
            signinData = JSON.parse(signinBody);
        } catch {
            signinData = null;
        }
    }

    if (!signinData) {
        // 非 JSON 响应，尝试判断是否成功
        const msg = signinBody || '签到完成（无响应内容）';
        const isSuccess = /成功|已签到|签到完成|ok/i.test(msg);
        return {
            account, serverid, serverName,
            success: isSuccess,
            stage: 'signin',
            msg: msg.substring(0, 200)
        };
    }

    return {
        account,
        serverid,
        serverName,
        success: signinData.code === 0,
        stage: 'signin',
        msg: signinData.msg || (signinData.code === 0 ? '签到成功' : '签到失败')
    };
}

/**
 * 展开账号列表：将含多区服的账号展开为单个签到任务
 * @param {Array} accounts - 账号列表，每项可含 serverid(单区) 或 servers(多区数组)
 * @returns {Array} 展开后的任务列表，每项含 account, pwd, serverid
 */
function expandAccounts(accounts) {
    const tasks = [];
    for (const acc of accounts) {
        if (Array.isArray(acc.servers) && acc.servers.length > 0) {
            // 多区服模式
            for (const sid of acc.servers) {
                tasks.push({
                    account: acc.account,
                    pwd: acc.pwd,
                    serverid: String(sid)
                });
            }
        } else if (acc.serverid) {
            // 单区服模式（兼容旧格式）
            tasks.push({
                account: acc.account,
                pwd: acc.pwd,
                serverid: String(acc.serverid)
            });
        }
    }
    return tasks;
}

/**
 * 批量签到
 * @param {Array} accounts - 账号列表（支持单区 serverid 或多区 servers）
 * @param {number} delay - 每个任务之间的延迟（毫秒）
 * @param {function} onProgress - 进度回调
 */
async function batchSignin(accounts, delay = 1500, onProgress = null) {
    // 展开多区服账号为独立任务
    const tasks = expandAccounts(accounts);
    const results = [];

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (onProgress) onProgress(i, tasks.length, task);

        const result = await loginAndSignin(task);
        results.push(result);

        // 最后一个不需要延迟
        if (i < tasks.length - 1 && delay > 0) {
            await new Promise(r => setTimeout(r, delay));
        }
    }
    return results;
}

// ========== 静态文件服务 ==========

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(__dirname, 'public', urlPath);
    // 安全检查：防止路径遍历
    if (!filePath.startsWith(path.join(__dirname, 'public'))) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

// ========== HTTP 服务端 ==========

// 云平台（Render/Railway/Fly等）会通过环境变量 PORT 指定端口
const SERVER_PORT = process.env.PORT || PORT;

const server = http.createServer(async (req, res) => {
    // CORS 头（本地使用）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    // ---- API: 配置信息（是否需要密码） ----
    if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            requireAuth: !!ACCESS_PASSWORD,
            target: TARGET_BASE,
            version: '1.0.0'
        }));
        return;
    }

    // ---- API: 登录鉴权 ----
    if (req.method === 'POST' && req.url === '/api/auth') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!ACCESS_PASSWORD) {
                    // 未设密码，直接返回令牌
                    const token = generateToken();
                    activeTokens.add(token);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, token, requireAuth: false }));
                } else if (data.password === ACCESS_PASSWORD) {
                    const token = generateToken();
                    activeTokens.add(token);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, token, requireAuth: true }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '密码错误' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: '请求格式错误' }));
            }
        });
        return;
    }

    // ---- API: 批量签到 ----
    if (req.method === 'POST' && req.url === '/api/batch-signin') {
        if (!verifyToken(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '未授权，请先登录' }));
            return;
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const params = JSON.parse(body);
                const accounts = params.accounts || [];
                const delay = params.delay || 1500;

                if (!Array.isArray(accounts) || accounts.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: '账号列表不能为空' }));
                    return;
                }

                // 校验每个账号（支持单区 serverid 或多区 servers）
                for (const acc of accounts) {
                    const hasServer = acc.serverid || (Array.isArray(acc.servers) && acc.servers.length > 0);
                    if (!acc.account || !acc.pwd || !hasServer) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ error: '每个账号必须包含 account, pwd 和区服(serverid或servers)' }));
                        return;
                    }
                }

                const results = await batchSignin(accounts, delay);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, results }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ---- API: 单账号测试签到 ----
    if (req.method === 'POST' && req.url === '/api/single-signin') {
        if (!verifyToken(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '未授权，请先登录' }));
            return;
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const acc = JSON.parse(body);
                // 支持单区 serverid 或多区 servers（取第一个）
                if (!acc.serverid && Array.isArray(acc.servers) && acc.servers.length > 0) {
                    acc.serverid = String(acc.servers[0]);
                }
                if (!acc.account || !acc.pwd || !acc.serverid) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: '缺少 account/pwd 和区服(serverid或servers)' }));
                    return;
                }
                const result = await loginAndSignin(acc);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ---- API: 服务状态 ----
    if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', target: TARGET_BASE, time: new Date().toISOString() }));
        return;
    }

    // ---- 静态文件 ----
    serveStatic(req, res);
});

server.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ========================================');
    console.log('    批量签到工具 服务已启动');
    console.log('  ========================================');
    console.log('');
    console.log(`  监听端口: ${SERVER_PORT}`);
    console.log(`  目标站点: ${TARGET_BASE}`);
    if (ACCESS_PASSWORD) {
        console.log(`  访问密码: 已设置`);
    } else {
        console.log(`  访问密码: 未设置（公开访问，建议设置密码）`);
    }
    console.log('');
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
});
