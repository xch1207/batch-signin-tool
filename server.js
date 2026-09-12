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

// ========== 内联前端页面（用于无 public 目录的部署环境） ==========
const INLINE_INDEX_HTML_B64 = `PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InpoLUNOIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+5om56YeP562+5Yiw5bel5YW3PC90aXRsZT4KPHN0eWxlPgogIDpyb290IHsKICAgIC0tYmc6ICMwZjBmMTQ7CiAgICAtLWNhcmQtYmc6ICMxYTFhMjQ7CiAgICAtLWNhcmQtYmcyOiAjMjIyMjJmOwogICAgLS1ib3JkZXI6ICMyYTJhMzg7CiAgICAtLWJvcmRlci1saWdodDogIzNhM2E0ZTsKICAgIC0tdGV4dDogI2UwZTBlNjsKICAgIC0tdGV4dC1tdXRlZDogIzg4ODhhMDsKICAgIC0tYWNjZW50OiAjN2M2ZmY3OwogICAgLS1hY2NlbnQtaG92ZXI6ICM5NDg4ZmY7CiAgICAtLWFjY2VudC1nbG93OiByZ2JhKDEyNCwgMTExLCAyNDcsIDAuMjUpOwogICAgLS1zdWNjZXNzOiAjMTBiOTgxOwogICAgLS1zdWNjZXNzLWJnOiByZ2JhKDE2LCAxODUsIDEyOSwgMC4xKTsKICAgIC0td2FybmluZzogI2Y1OWUwYjsKICAgIC0td2FybmluZy1iZzogcmdiYSgyNDUsIDE1OCwgMTEsIDAuMSk7CiAgICAtLWRhbmdlcjogI2VmNDQ0NDsKICAgIC0tZGFuZ2VyLWJnOiByZ2JhKDIzOSwgNjgsIDY4LCAwLjEpOwogICAgLS1pbmZvOiAjM2I4MmY2OwogICAgLS1pbmZvLWJnOiByZ2JhKDU5LCAxMzAsIDI0NiwgMC4xKTsKICAgIC0tcmFkaXVzOiAxMnB4OwogICAgLS1yYWRpdXMtc206IDhweDsKICAgIC0tdHJhbnNpdGlvbjogMC4ycyBlYXNlOwogIH0KCiAgKiB7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgYm94LXNpemluZzogYm9yZGVyLWJveDsgfQoKICBib2R5IHsKICAgIGZvbnQtZmFtaWx5OiAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsICJTZWdvZSBVSSIsICJQaW5nRmFuZyBTQyIsICJNaWNyb3NvZnQgWWFIZWkiLCBzYW5zLXNlcmlmOwogICAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogICAgY29sb3I6IHZhcigtLXRleHQpOwogICAgbWluLWhlaWdodDogMTAwdmg7CiAgICBsaW5lLWhlaWdodDogMS42OwogICAgYmFja2dyb3VuZC1pbWFnZToKICAgICAgcmFkaWFsLWdyYWRpZW50KGVsbGlwc2UgYXQgMTUlIDAlLCByZ2JhKDEyNCwgMTExLCAyNDcsIDAuMDcpIDAlLCB0cmFuc3BhcmVudCA1NSUpLAogICAgICByYWRpYWwtZ3JhZGllbnQoZWxsaXBzZSBhdCA4NSUgMTAwJSwgcmdiYSgxMjQsIDExMSwgMjQ3LCAwLjA1KSAwJSwgdHJhbnNwYXJlbnQgNTUlKTsKICB9CgogIC5jb250YWluZXIgewogICAgbWF4LXdpZHRoOiAxMTAwcHg7CiAgICBtYXJnaW46IDAgYXV0bzsKICAgIHBhZGRpbmc6IDI4cHggMjBweCA2MHB4OwogIH0KCiAgLyogPT09PT0g5aS06YOoID09PT09ICovCiAgLmhlYWRlciB7CiAgICB0ZXh0LWFsaWduOiBjZW50ZXI7CiAgICBtYXJnaW4tYm90dG9tOiAyOHB4OwogIH0KICAuaGVhZGVyIGgxIHsKICAgIGZvbnQtc2l6ZTogMjhweDsKICAgIGZvbnQtd2VpZ2h0OiA3MDA7CiAgICBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCB2YXIoLS1hY2NlbnQpLCAjYTc4YmZhKTsKICAgIC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOiB0ZXh0OwogICAgLXdlYmtpdC10ZXh0LWZpbGwtY29sb3I6IHRyYW5zcGFyZW50OwogICAgYmFja2dyb3VuZC1jbGlwOiB0ZXh0OwogICAgbWFyZ2luLWJvdHRvbTogNnB4OwogIH0KICAuaGVhZGVyIHAgewogICAgY29sb3I6IHZhcigtLXRleHQtbXV0ZWQpOwogICAgZm9udC1zaXplOiAxNHB4OwogIH0KICAuc3RhdHVzLWJhZGdlIHsKICAgIGRpc3BsYXk6IGlubGluZS1mbGV4OwogICAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICAgIGdhcDogNnB4OwogICAgcGFkZGluZzogNHB4IDEycHg7CiAgICBib3JkZXItcmFkaXVzOiAyMHB4OwogICAgZm9udC1zaXplOiAxMnB4OwogICAgbWFyZ2luLXRvcDogMTBweDsKICB9CiAgLnN0YXR1cy1iYWRnZS5vbmxpbmUgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdWNjZXNzLWJnKTsgY29sb3I6IHZhcigtLXN1Y2Nlc3MpOyB9CiAgLnN0YXR1cy1iYWRnZS5vZmZsaW5lIHsgYmFja2dyb3VuZDogdmFyKC0tZGFuZ2VyLWJnKTsgY29sb3I6IHZhcigtLWRhbmdlcik7IH0KICAuc3RhdHVzLWRvdCB7CiAgICB3aWR0aDogN3B4OyBoZWlnaHQ6IDdweDsgYm9yZGVyLXJhZGl1czogNTAlOwogICAgYmFja2dyb3VuZDogY3VycmVudENvbG9yOwogICAgYW5pbWF0aW9uOiBwdWxzZSAycyBpbmZpbml0ZTsKICB9CiAgQGtleWZyYW1lcyBwdWxzZSB7CiAgICAwJSwgMTAwJSB7IG9wYWNpdHk6IDE7IH0KICAgIDUwJSB7IG9wYWNpdHk6IDAuNDsgfQogIH0KCiAgLyogPT09PT0g5Y2h54mHID09PT09ICovCiAgLmNhcmQgewogICAgYmFja2dyb3VuZDogdmFyKC0tY2FyZC1iZyk7CiAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogICAgYm9yZGVyLXJhZGl1czogdmFyKC0tcmFkaXVzKTsKICAgIHBhZGRpbmc6IDI0cHg7CiAgICBtYXJnaW4tYm90dG9tOiAyMHB4OwogICAgYm94LXNoYWRvdzogMCA0cHggMjRweCByZ2JhKDAsMCwwLDAuMik7CiAgfQogIC5jYXJkLXRpdGxlIHsKICAgIGZvbnQtc2l6ZTogMTZweDsKICAgIGZvbnQtd2VpZ2h0OiA2MDA7CiAgICBtYXJnaW4tYm90dG9tOiAxOHB4OwogICAgZGlzcGxheTogZmxleDsKICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgICBnYXA6IDEwcHg7CiAgfQogIC5jYXJkLXRpdGxlOjpiZWZvcmUgewogICAgY29udGVudDogJyc7CiAgICB3aWR0aDogM3B4OyBoZWlnaHQ6IDE4cHg7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOwogICAgYm9yZGVyLXJhZGl1czogMnB4OwogIH0KCiAgLyogPT09PT0g6LSm5Y+35YiX6KGoID09PT09ICovCiAgLmFjY291bnQtbGlzdCB7CiAgICBkaXNwbGF5OiBmbGV4OwogICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICAgIGdhcDogMTBweDsKICB9CiAgLmFjY291bnQtcm93IHsKICAgIGRpc3BsYXk6IGZsZXg7CiAgICBhbGlnbi1pdGVtczogY2VudGVyOwogICAgZ2FwOiAxMHB4OwogICAgcGFkZGluZzogMTJweCAxNHB4OwogICAgYmFja2dyb3VuZDogdmFyKC0tY2FyZC1iZzIpOwogICAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICAgIGJvcmRlci1yYWRpdXM6IHZhcigtLXJhZGl1cy1zbSk7CiAgICB0cmFuc2l0aW9uOiBib3JkZXItY29sb3IgdmFyKC0tdHJhbnNpdGlvbik7CiAgICBhbmltYXRpb246IGZhZGVJbiAwLjNzIGVhc2U7CiAgfQogIC5hY2NvdW50LXJvdzpob3ZlciB7IGJvcmRlci1jb2xvcjogdmFyKC0tYm9yZGVyLWxpZ2h0KTsgfQogIEBrZXlmcmFtZXMgZmFkZUluIHsKICAgIGZyb20geyBvcGFjaXR5OiAwOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoLTZweCk7IH0KICAgIHRvIHsgb3BhY2l0eTogMTsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDApOyB9CiAgfQogIC5hY2NvdW50LXJvdyAuaWR4IHsKICAgIHdpZHRoOiAyOHB4OyBoZWlnaHQ6IDI4cHg7CiAgICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICAgIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1nbG93KTsKICAgIGNvbG9yOiB2YXIoLS1hY2NlbnQpOwogICAgYm9yZGVyLXJhZGl1czogNnB4OwogICAgZm9udC1zaXplOiAxM3B4OwogICAgZm9udC13ZWlnaHQ6IDYwMDsKICAgIGZsZXgtc2hyaW5rOiAwOwogIH0KICAuYWNjb3VudC1yb3cgaW5wdXQsIC5hY2NvdW50LXJvdyBzZWxlY3QgewogICAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogICAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICAgIGNvbG9yOiB2YXIoLS10ZXh0KTsKICAgIHBhZGRpbmc6IDhweCAxMnB4OwogICAgYm9yZGVyLXJhZGl1czogNnB4OwogICAgZm9udC1zaXplOiAxM3B4OwogICAgb3V0bGluZTogbm9uZTsKICAgIHRyYW5zaXRpb246IGJvcmRlci1jb2xvciB2YXIoLS10cmFuc2l0aW9uKTsKICB9CiAgLmFjY291bnQtcm93IGlucHV0OmZvY3VzLCAuYWNjb3VudC1yb3cgc2VsZWN0OmZvY3VzIHsKICAgIGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsKICB9CiAgLmFjY291bnQtcm93IGlucHV0IHsgZmxleDogMS4yOyBtaW4td2lkdGg6IDA7IH0KICAuYWNjb3VudC1yb3cgaW5wdXRbdHlwZT0icGFzc3dvcmQiXSB7IGZsZXg6IDE7IH0KICAuYWNjb3VudC1yb3cgc2VsZWN0IHsgZmxleDogMCAwIDgwcHg7IGN1cnNvcjogcG9pbnRlcjsgfQogIC5idG4tZGVsIHsKICAgIHdpZHRoOiAzMnB4OyBoZWlnaHQ6IDMycHg7CiAgICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICAgIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OwogICAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTsKICAgIGJvcmRlci1yYWRpdXM6IDZweDsKICAgIGN1cnNvcjogcG9pbnRlcjsKICAgIGZvbnQtc2l6ZTogMTZweDsKICAgIHRyYW5zaXRpb246IGFsbCB2YXIoLS10cmFuc2l0aW9uKTsKICAgIGZsZXgtc2hyaW5rOiAwOwogIH0KICAuYnRuLWRlbDpob3ZlciB7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1kYW5nZXItYmcpOwogICAgYm9yZGVyLWNvbG9yOiB2YXIoLS1kYW5nZXIpOwogICAgY29sb3I6IHZhcigtLWRhbmdlcik7CiAgfQoKICAvKiA9PT09PSDlpJrpgInljLrmnI3nu4Tku7YgPT09PT0gKi8KICAuem9uZS1zZWxlY3QgewogICAgcG9zaXRpb246IHJlbGF0aXZlOwogICAgZmxleC1zaHJpbms6IDA7CiAgfQogIC56b25lLWJ0biB7CiAgICBkaXNwbGF5OiBmbGV4OwogICAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICAgIGdhcDogNnB4OwogICAgcGFkZGluZzogOHB4IDEycHg7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogICAgY29sb3I6IHZhcigtLXRleHQpOwogICAgYm9yZGVyLXJhZGl1czogNnB4OwogICAgZm9udC1zaXplOiAxM3B4OwogICAgY3Vyc29yOiBwb2ludGVyOwogICAgdHJhbnNpdGlvbjogYm9yZGVyLWNvbG9yIHZhcigtLXRyYW5zaXRpb24pOwogICAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKICAgIG1pbi13aWR0aDogOTBweDsKICAgIGp1c3RpZnktY29udGVudDogY2VudGVyOwogIH0KICAuem9uZS1idG46aG92ZXIgeyBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7IH0KICAuem9uZS1idG4gLnpvbmUtY291bnQgewogICAgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LWdsb3cpOwogICAgY29sb3I6IHZhcigtLWFjY2VudCk7CiAgICBwYWRkaW5nOiAxcHggN3B4OwogICAgYm9yZGVyLXJhZGl1czogMTBweDsKICAgIGZvbnQtc2l6ZTogMTFweDsKICAgIGZvbnQtd2VpZ2h0OiA2MDA7CiAgfQogIC56b25lLXBhbmVsIHsKICAgIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICAgIHRvcDogY2FsYygxMDAlICsgNnB4KTsKICAgIGxlZnQ6IDA7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1jYXJkLWJnKTsKICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1saWdodCk7CiAgICBib3JkZXItcmFkaXVzOiAxMHB4OwogICAgcGFkZGluZzogMTJweDsKICAgIGJveC1zaGFkb3c6IDAgMTJweCAzMnB4IHJnYmEoMCwwLDAsMC40KTsKICAgIHotaW5kZXg6IDEwMDsKICAgIG1pbi13aWR0aDogMjAwcHg7CiAgICBkaXNwbGF5OiBub25lOwogICAgYW5pbWF0aW9uOiBmYWRlVXAgMC4xNXMgZWFzZTsKICB9CiAgLnpvbmUtcGFuZWwuc2hvdyB7IGRpc3BsYXk6IGJsb2NrOyB9CiAgLnpvbmUtcGFuZWwtdGl0bGUgewogICAgZm9udC1zaXplOiAxMnB4OwogICAgY29sb3I6IHZhcigtLXRleHQtbXV0ZWQpOwogICAgbWFyZ2luLWJvdHRvbTogOHB4OwogICAgZGlzcGxheTogZmxleDsKICAgIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgfQogIC56b25lLXBhbmVsLXRpdGxlIGEgewogICAgY29sb3I6IHZhcigtLWFjY2VudCk7CiAgICBjdXJzb3I6IHBvaW50ZXI7CiAgICB0ZXh0LWRlY29yYXRpb246IG5vbmU7CiAgICBmb250LXNpemU6IDEycHg7CiAgfQogIC56b25lLXBhbmVsLXRpdGxlIGE6aG92ZXIgeyB0ZXh0LWRlY29yYXRpb246IHVuZGVybGluZTsgfQogIC56b25lLWdyaWQgewogICAgZGlzcGxheTogZ3JpZDsKICAgIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDQsIDFmcik7CiAgICBnYXA6IDZweDsKICB9CiAgLnpvbmUtaXRlbSB7CiAgICBkaXNwbGF5OiBmbGV4OwogICAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICAgIGp1c3RpZnktY29udGVudDogY2VudGVyOwogICAgcGFkZGluZzogNnB4IDRweDsKICAgIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgICBib3JkZXItcmFkaXVzOiA2cHg7CiAgICBmb250LXNpemU6IDEycHg7CiAgICBjdXJzb3I6IHBvaW50ZXI7CiAgICB0cmFuc2l0aW9uOiBhbGwgMC4xNXM7CiAgICB1c2VyLXNlbGVjdDogbm9uZTsKICB9CiAgLnpvbmUtaXRlbTpob3ZlciB7IGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsgfQogIC56b25lLWl0ZW0uYWN0aXZlIHsKICAgIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1nbG93KTsKICAgIGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsKICAgIGNvbG9yOiB2YXIoLS1hY2NlbnQpOwogICAgZm9udC13ZWlnaHQ6IDYwMDsKICB9CgogIC8qID09PT09IOWvhueggeWIhue7hCA9PT09PSAqLwogIC5ncm91cC1iYXIgewogICAgZGlzcGxheTogZmxleDsKICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgICBnYXA6IDhweDsKICAgIHBhZGRpbmc6IDEwcHggMTJweDsKICAgIGJhY2tncm91bmQ6IHZhcigtLWNhcmQtYmcyKTsKICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgICBib3JkZXItcmFkaXVzOiB2YXIoLS1yYWRpdXMtc20pOwogICAgbWFyZ2luLWJvdHRvbTogMTJweDsKICAgIGZsZXgtd3JhcDogd3JhcDsKICB9CiAgLmdyb3VwLWJhci1sYWJlbCB7CiAgICBmb250LXNpemU6IDEzcHg7CiAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7CiAgICBtYXJnaW4tcmlnaHQ6IDRweDsKICAgIHdoaXRlLXNwYWNlOiBub3dyYXA7CiAgfQogIC5ncm91cC1jaGlwIHsKICAgIGRpc3BsYXk6IGlubGluZS1mbGV4OwogICAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICAgIGdhcDogNnB4OwogICAgcGFkZGluZzogNXB4IDEwcHg7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogICAgYm9yZGVyLXJhZGl1czogMjBweDsKICAgIGZvbnQtc2l6ZTogMTJweDsKICAgIGN1cnNvcjogcG9pbnRlcjsKICAgIHRyYW5zaXRpb246IGFsbCAwLjE1czsKICAgIHVzZXItc2VsZWN0OiBub25lOwogIH0KICAuZ3JvdXAtY2hpcDpob3ZlciB7IGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsgfQogIC5ncm91cC1jaGlwLmFjdGl2ZSB7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtZ2xvdyk7CiAgICBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7CiAgICBjb2xvcjogdmFyKC0tYWNjZW50KTsKICB9CiAgLmdyb3VwLWNoaXAgLmdyb3VwLW5hbWUgeyBmb250LXdlaWdodDogNTAwOyB9CiAgLmdyb3VwLWNoaXAgLmdyb3VwLXB3ZCB7CiAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7CiAgICBmb250LXNpemU6IDExcHg7CiAgfQogIC5ncm91cC1jaGlwLmFjdGl2ZSAuZ3JvdXAtcHdkIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IG9wYWNpdHk6IDAuODsgfQogIC5ncm91cC1jaGlwIC5ncm91cC1kZWwgewogICAgd2lkdGg6IDE2cHg7IGhlaWdodDogMTZweDsKICAgIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyOwogICAgYm9yZGVyLXJhZGl1czogNTAlOwogICAgY29sb3I6IHZhcigtLXRleHQtbXV0ZWQpOwogICAgZm9udC1zaXplOiAxNHB4OwogICAgbGluZS1oZWlnaHQ6IDE7CiAgfQogIC5ncm91cC1jaGlwIC5ncm91cC1kZWw6aG92ZXIgewogICAgYmFja2dyb3VuZDogdmFyKC0tZGFuZ2VyLWJnKTsKICAgIGNvbG9yOiB2YXIoLS1kYW5nZXIpOwogIH0KICAuZ3JvdXAtYWRkLWJ0biB7CiAgICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgICBnYXA6IDRweDsKICAgIHBhZGRpbmc6IDVweCAxMnB4OwogICAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgICBib3JkZXI6IDFweCBkYXNoZWQgdmFyKC0tYm9yZGVyLWxpZ2h0KTsKICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTsKICAgIGJvcmRlci1yYWRpdXM6IDIwcHg7CiAgICBmb250LXNpemU6IDEycHg7CiAgICBjdXJzb3I6IHBvaW50ZXI7CiAgICB0cmFuc2l0aW9uOiBhbGwgMC4xNXM7CiAgfQogIC5ncm91cC1hZGQtYnRuOmhvdmVyIHsKICAgIGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsKICAgIGNvbG9yOiB2YXIoLS1hY2NlbnQpOwogIH0KICAuZ3JvdXAtZWRpdC1wYW5lbCB7CiAgICBkaXNwbGF5OiBmbGV4OwogICAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICAgIGdhcDogOHB4OwogICAgcGFkZGluZzogOHB4IDEycHg7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1hY2NlbnQpOwogICAgYm9yZGVyLXJhZGl1czogdmFyKC0tcmFkaXVzLXNtKTsKICAgIG1hcmdpbi1ib3R0b206IDEycHg7CiAgICBmbGV4LXdyYXA6IHdyYXA7CiAgfQogIC5ncm91cC1lZGl0LXBhbmVsIGlucHV0IHsKICAgIGJhY2tncm91bmQ6IHZhcigtLWNhcmQtYmcpOwogICAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICAgIGNvbG9yOiB2YXIoLS10ZXh0KTsKICAgIHBhZGRpbmc6IDZweCAxMHB4OwogICAgYm9yZGVyLXJhZGl1czogNnB4OwogICAgZm9udC1zaXplOiAxM3B4OwogICAgb3V0bGluZTogbm9uZTsKICB9CiAgLmdyb3VwLWVkaXQtcGFuZWwgaW5wdXQ6Zm9jdXMgeyBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7IH0KICAuZ3JvdXAtZWRpdC1wYW5lbCBpbnB1dC5ncm91cC1uYW1lLWlucHV0IHsgd2lkdGg6IDEwMHB4OyB9CiAgLmdyb3VwLWVkaXQtcGFuZWwgaW5wdXQuZ3JvdXAtcHdkLWlucHV0IHsgZmxleDogMTsgbWluLXdpZHRoOiAxMjBweDsgfQogIC5ncm91cC1zZWxlY3QgewogICAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogICAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICAgIGNvbG9yOiB2YXIoLS10ZXh0KTsKICAgIHBhZGRpbmc6IDhweCA4cHg7CiAgICBib3JkZXItcmFkaXVzOiA2cHg7CiAgICBmb250LXNpemU6IDEycHg7CiAgICBjdXJzb3I6IHBvaW50ZXI7CiAgICBvdXRsaW5lOiBub25lOwogICAgZmxleC1zaHJpbms6IDA7CiAgICBtYXgtd2lkdGg6IDkwcHg7CiAgfQogIC5ncm91cC1zZWxlY3Q6Zm9jdXMgeyBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7IH0KICAuYWNjb3VudC1yb3cgLnB3ZC1maWVsZC5pbmRlcGVuZGVudC1oaWRkZW4geyBkaXNwbGF5OiBub25lOyB9CgogIC8qID09PT09IOaMiemSriA9PT09PSAqLwogIC5idG4gewogICAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgICBhbGlnbi1pdGVtczogY2VudGVyOwogICAganVzdGlmeS1jb250ZW50OiBjZW50ZXI7CiAgICBnYXA6IDZweDsKICAgIHBhZGRpbmc6IDEwcHggMjBweDsKICAgIGJvcmRlcjogbm9uZTsKICAgIGJvcmRlci1yYWRpdXM6IHZhcigtLXJhZGl1cy1zbSk7CiAgICBmb250LXNpemU6IDE0cHg7CiAgICBmb250LXdlaWdodDogNTAwOwogICAgY3Vyc29yOiBwb2ludGVyOwogICAgdHJhbnNpdGlvbjogYWxsIHZhcigtLXRyYW5zaXRpb24pOwogICAgZm9udC1mYW1pbHk6IGluaGVyaXQ7CiAgfQogIC5idG46ZGlzYWJsZWQgeyBvcGFjaXR5OiAwLjU7IGN1cnNvcjogbm90LWFsbG93ZWQ7IH0KICAuYnRuLXByaW1hcnkgewogICAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgdmFyKC0tYWNjZW50KSwgIzZkNWNlNik7CiAgICBjb2xvcjogI2ZmZjsKICAgIGJveC1zaGFkb3c6IDAgNHB4IDE2cHggdmFyKC0tYWNjZW50LWdsb3cpOwogIH0KICAuYnRuLXByaW1hcnk6aG92ZXI6bm90KDpkaXNhYmxlZCkgewogICAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgdmFyKC0tYWNjZW50LWhvdmVyKSwgIzdjNmZmNyk7CiAgICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoLTFweCk7CiAgICBib3gtc2hhZG93OiAwIDZweCAyMHB4IHZhcigtLWFjY2VudC1nbG93KTsKICB9CiAgLmJ0bi1zZWNvbmRhcnkgewogICAgYmFja2dyb3VuZDogdmFyKC0tY2FyZC1iZzIpOwogICAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICAgIGNvbG9yOiB2YXIoLS10ZXh0KTsKICB9CiAgLmJ0bi1zZWNvbmRhcnk6aG92ZXI6bm90KDpkaXNhYmxlZCkgewogICAgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOwogICAgY29sb3I6IHZhcigtLWFjY2VudCk7CiAgfQogIC5idG4tZGFuZ2VyIHsKICAgIGJhY2tncm91bmQ6IHZhcigtLWRhbmdlci1iZyk7CiAgICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDIzOSw2OCw2OCwwLjMpOwogICAgY29sb3I6IHZhcigtLWRhbmdlcik7CiAgfQogIC5idG4tZGFuZ2VyOmhvdmVyOm5vdCg6ZGlzYWJsZWQpIHsKICAgIGJhY2tncm91bmQ6IHJnYmEoMjM5LDY4LDY4LDAuMik7CiAgfQogIC5idG4tbGcgewogICAgcGFkZGluZzogMTRweCAzMnB4OwogICAgZm9udC1zaXplOiAxNnB4OwogICAgd2lkdGg6IDEwMCU7CiAgfQoKICAuYnRuLWdyb3VwIHsKICAgIGRpc3BsYXk6IGZsZXg7CiAgICBnYXA6IDEwcHg7CiAgICBmbGV4LXdyYXA6IHdyYXA7CiAgfQoKICAvKiA9PT09PSDmibnph4/lr7zlhaUgPT09PT0gKi8KICAuaW1wb3J0LWFyZWEgewogICAgd2lkdGg6IDEwMCU7CiAgICBtaW4taGVpZ2h0OiAxMDBweDsKICAgIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgICBwYWRkaW5nOiAxMnB4OwogICAgYm9yZGVyLXJhZGl1czogdmFyKC0tcmFkaXVzLXNtKTsKICAgIGZvbnQtc2l6ZTogMTNweDsKICAgIGZvbnQtZmFtaWx5OiAiQ29uc29sYXMiLCAiTW9uYWNvIiwgbW9ub3NwYWNlOwogICAgcmVzaXplOiB2ZXJ0aWNhbDsKICAgIG91dGxpbmU6IG5vbmU7CiAgICB0cmFuc2l0aW9uOiBib3JkZXItY29sb3IgdmFyKC0tdHJhbnNpdGlvbik7CiAgfQogIC5pbXBvcnQtYXJlYTpmb2N1cyB7IGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsgfQogIC5pbXBvcnQtaGludCB7CiAgICBmb250LXNpemU6IDEycHg7CiAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7CiAgICBtYXJnaW4tdG9wOiA4cHg7CiAgICBsaW5lLWhlaWdodDogMS41OwogIH0KICAuaW1wb3J0LWhpbnQgY29kZSB7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1jYXJkLWJnMik7CiAgICBwYWRkaW5nOiAycHggNnB4OwogICAgYm9yZGVyLXJhZGl1czogNHB4OwogICAgY29sb3I6IHZhcigtLWFjY2VudCk7CiAgfQoKICAvKiA9PT09PSDorr7nva4gPT09PT0gKi8KICAuc2V0dGluZ3Mtcm93IHsKICAgIGRpc3BsYXk6IGZsZXg7CiAgICBhbGlnbi1pdGVtczogY2VudGVyOwogICAgZ2FwOiAxMnB4OwogICAgZmxleC13cmFwOiB3cmFwOwogIH0KICAuc2V0dGluZ3Mtcm93IGxhYmVsIHsKICAgIGZvbnQtc2l6ZTogMTNweDsKICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTsKICAgIGRpc3BsYXk6IGZsZXg7CiAgICBhbGlnbi1pdGVtczogY2VudGVyOwogICAgZ2FwOiA4cHg7CiAgfQogIC5zZXR0aW5ncy1yb3cgaW5wdXRbdHlwZT0ibnVtYmVyIl0gewogICAgd2lkdGg6IDgwcHg7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogICAgY29sb3I6IHZhcigtLXRleHQpOwogICAgcGFkZGluZzogNnB4IDEwcHg7CiAgICBib3JkZXItcmFkaXVzOiA2cHg7CiAgICBmb250LXNpemU6IDEzcHg7CiAgICBvdXRsaW5lOiBub25lOwogIH0KICAuc2V0dGluZ3Mtcm93IGlucHV0W3R5cGU9Im51bWJlciJdOmZvY3VzIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9CgogIC8qID09PT09IOi/m+W6puadoSA9PT09PSAqLwogIC5wcm9ncmVzcy13cmFwIHsKICAgIGRpc3BsYXk6IG5vbmU7CiAgICBtYXJnaW4tYm90dG9tOiAxNnB4OwogIH0KICAucHJvZ3Jlc3Mtd3JhcC5hY3RpdmUgeyBkaXNwbGF5OiBibG9jazsgfQogIC5wcm9ncmVzcy1pbmZvIHsKICAgIGRpc3BsYXk6IGZsZXg7CiAgICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgICBmb250LXNpemU6IDEzcHg7CiAgICBtYXJnaW4tYm90dG9tOiA4cHg7CiAgfQogIC5wcm9ncmVzcy1pbmZvIC5jdXJyZW50IHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGZvbnQtd2VpZ2h0OiA1MDA7IH0KICAucHJvZ3Jlc3MtYmFyIHsKICAgIGhlaWdodDogOHB4OwogICAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogICAgYm9yZGVyLXJhZGl1czogNHB4OwogICAgb3ZlcmZsb3c6IGhpZGRlbjsKICB9CiAgLnByb2dyZXNzLWZpbGwgewogICAgaGVpZ2h0OiAxMDAlOwogICAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCB2YXIoLS1hY2NlbnQpLCAjYTc4YmZhKTsKICAgIGJvcmRlci1yYWRpdXM6IDRweDsKICAgIHRyYW5zaXRpb246IHdpZHRoIDAuM3MgZWFzZTsKICAgIHdpZHRoOiAwJTsKICB9CgogIC8qID09PT09IOe7n+iuoSA9PT09PSAqLwogIC5zdGF0cy1ncmlkIHsKICAgIGRpc3BsYXk6IGdyaWQ7CiAgICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg0LCAxZnIpOwogICAgZ2FwOiAxMnB4OwogICAgbWFyZ2luLWJvdHRvbTogMTZweDsKICB9CiAgLnN0YXQtY2FyZCB7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1jYXJkLWJnMik7CiAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogICAgYm9yZGVyLXJhZGl1czogdmFyKC0tcmFkaXVzLXNtKTsKICAgIHBhZGRpbmc6IDE0cHg7CiAgICB0ZXh0LWFsaWduOiBjZW50ZXI7CiAgfQogIC5zdGF0LXZhbHVlIHsKICAgIGZvbnQtc2l6ZTogMjRweDsKICAgIGZvbnQtd2VpZ2h0OiA3MDA7CiAgICBtYXJnaW4tYm90dG9tOiAycHg7CiAgfQogIC5zdGF0LWxhYmVsIHsKICAgIGZvbnQtc2l6ZTogMTJweDsKICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTsKICB9CiAgLnN0YXQtY2FyZC50b3RhbCAuc3RhdC12YWx1ZSB7IGNvbG9yOiB2YXIoLS1pbmZvKTsgfQogIC5zdGF0LWNhcmQuc3VjY2VzcyAuc3RhdC12YWx1ZSB7IGNvbG9yOiB2YXIoLS1zdWNjZXNzKTsgfQogIC5zdGF0LWNhcmQuZmFpbCAuc3RhdC12YWx1ZSB7IGNvbG9yOiB2YXIoLS1kYW5nZXIpOyB9CiAgLnN0YXQtY2FyZC5wZW5kaW5nIC5zdGF0LXZhbHVlIHsgY29sb3I6IHZhcigtLXdhcm5pbmcpOyB9CgogIC8qID09PT09IOe7k+aenOihqOagvCA9PT09PSAqLwogIC5yZXN1bHQtdGFibGUgewogICAgd2lkdGg6IDEwMCU7CiAgICBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlOwogICAgZm9udC1zaXplOiAxM3B4OwogIH0KICAucmVzdWx0LXRhYmxlIHRoIHsKICAgIHRleHQtYWxpZ246IGxlZnQ7CiAgICBwYWRkaW5nOiAxMHB4IDEycHg7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1jYXJkLWJnMik7CiAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7CiAgICBmb250LXdlaWdodDogNTAwOwogICAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgICB3aGl0ZS1zcGFjZTogbm93cmFwOwogIH0KICAucmVzdWx0LXRhYmxlIHRkIHsKICAgIHBhZGRpbmc6IDEwcHggMTJweDsKICAgIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCByZ2JhKDQyLDQyLDU2LDAuNSk7CiAgfQogIC5yZXN1bHQtdGFibGUgdHI6aG92ZXIgdGQgeyBiYWNrZ3JvdW5kOiByZ2JhKDEyNCwxMTEsMjQ3LDAuMDMpOyB9CiAgLnN0YXR1cy10YWcgewogICAgZGlzcGxheTogaW5saW5lLWZsZXg7CiAgICBhbGlnbi1pdGVtczogY2VudGVyOwogICAgZ2FwOiA1cHg7CiAgICBwYWRkaW5nOiAzcHggMTBweDsKICAgIGJvcmRlci1yYWRpdXM6IDIwcHg7CiAgICBmb250LXNpemU6IDEycHg7CiAgICBmb250LXdlaWdodDogNTAwOwogIH0KICAuc3RhdHVzLXRhZy5zdWNjZXNzIHsgYmFja2dyb3VuZDogdmFyKC0tc3VjY2Vzcy1iZyk7IGNvbG9yOiB2YXIoLS1zdWNjZXNzKTsgfQogIC5zdGF0dXMtdGFnLmZhaWwgeyBiYWNrZ3JvdW5kOiB2YXIoLS1kYW5nZXItYmcpOyBjb2xvcjogdmFyKC0tZGFuZ2VyKTsgfQogIC5zdGF0dXMtdGFnLnBlbmRpbmcgeyBiYWNrZ3JvdW5kOiB2YXIoLS13YXJuaW5nLWJnKTsgY29sb3I6IHZhcigtLXdhcm5pbmcpOyB9CiAgLnN0YXR1cy10YWcucnVubmluZyB7IGJhY2tncm91bmQ6IHZhcigtLWluZm8tYmcpOyBjb2xvcjogdmFyKC0taW5mbyk7IH0KICAubXNnLXRleHQgewogICAgY29sb3I6IHZhcigtLXRleHQtbXV0ZWQpOwogICAgZm9udC1zaXplOiAxMnB4OwogICAgbWF4LXdpZHRoOiAzMDBweDsKICAgIHdvcmQtYnJlYWs6IGJyZWFrLWFsbDsKICB9CgogIC5lbXB0eS1zdGF0ZSB7CiAgICB0ZXh0LWFsaWduOiBjZW50ZXI7CiAgICBwYWRkaW5nOiA0MHB4IDIwcHg7CiAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7CiAgfQogIC5lbXB0eS1zdGF0ZSAuaWNvbiB7CiAgICBmb250LXNpemU6IDQwcHg7CiAgICBtYXJnaW4tYm90dG9tOiAxMnB4OwogICAgb3BhY2l0eTogMC41OwogIH0KCiAgLyogPT09PT0gVG9hc3QgPT09PT0gKi8KICAudG9hc3QtY29udGFpbmVyIHsKICAgIHBvc2l0aW9uOiBmaXhlZDsKICAgIHRvcDogMjBweDsKICAgIHJpZ2h0OiAyMHB4OwogICAgei1pbmRleDogOTk5OTsKICAgIGRpc3BsYXk6IGZsZXg7CiAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogICAgZ2FwOiA4cHg7CiAgfQogIC50b2FzdCB7CiAgICBwYWRkaW5nOiAxMnB4IDIwcHg7CiAgICBib3JkZXItcmFkaXVzOiB2YXIoLS1yYWRpdXMtc20pOwogICAgZm9udC1zaXplOiAxM3B4OwogICAgY29sb3I6ICNmZmY7CiAgICBib3gtc2hhZG93OiAwIDRweCAyMHB4IHJnYmEoMCwwLDAsMC4zKTsKICAgIGFuaW1hdGlvbjogc2xpZGVJbiAwLjNzIGVhc2U7CiAgICBtYXgtd2lkdGg6IDMyMHB4OwogIH0KICAudG9hc3Quc3VjY2VzcyB7IGJhY2tncm91bmQ6IHZhcigtLXN1Y2Nlc3MpOyB9CiAgLnRvYXN0LmVycm9yIHsgYmFja2dyb3VuZDogdmFyKC0tZGFuZ2VyKTsgfQogIC50b2FzdC5pbmZvIHsgYmFja2dyb3VuZDogdmFyKC0taW5mbyk7IH0KICBAa2V5ZnJhbWVzIHNsaWRlSW4gewogICAgZnJvbSB7IG9wYWNpdHk6IDA7IHRyYW5zZm9ybTogdHJhbnNsYXRlWCgzMHB4KTsgfQogICAgdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMCk7IH0KICB9CgogIC8qID09PT09IOWTjeW6lOW8jyA9PT09PSAqLwogIEBtZWRpYSAobWF4LXdpZHRoOiA3NjhweCkgewogICAgLnN0YXRzLWdyaWQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCgyLCAxZnIpOyB9CiAgICAuYWNjb3VudC1yb3cgeyBmbGV4LXdyYXA6IHdyYXA7IH0KICAgIC5hY2NvdW50LXJvdyBpbnB1dCB7IGZsZXg6IDEgMSAxMDAlOyB9CiAgICAuYWNjb3VudC1yb3cgaW5wdXRbdHlwZT0icGFzc3dvcmQiXSB7IGZsZXg6IDEgMSBjYWxjKDUwJSAtIDVweCk7IH0KICAgIC5hY2NvdW50LXJvdyBzZWxlY3QgeyBmbGV4OiAxIDEgY2FsYyg1MCUgLSA1cHgpOyB9CiAgfQoKICAvKiDmu5rliqjmnaEgKi8KICA6Oi13ZWJraXQtc2Nyb2xsYmFyIHsgd2lkdGg6IDhweDsgaGVpZ2h0OiA4cHg7IH0KICA6Oi13ZWJraXQtc2Nyb2xsYmFyLXRyYWNrIHsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyB9CiAgOjotd2Via2l0LXNjcm9sbGJhci10aHVtYiB7IGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7IGJvcmRlci1yYWRpdXM6IDRweDsgfQogIDo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWI6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXItbGlnaHQpOyB9CgogIC8qID09PT09IOeZu+W9lemBrue9qSA9PT09PSAqLwogIC5hdXRoLW1hc2sgewogICAgcG9zaXRpb246IGZpeGVkOwogICAgdG9wOiAwOyBsZWZ0OiAwOyByaWdodDogMDsgYm90dG9tOiAwOwogICAgYmFja2dyb3VuZDogcmdiYSgxNSwgMTUsIDIwLCAwLjkyKTsKICAgIGJhY2tkcm9wLWZpbHRlcjogYmx1cig4cHgpOwogICAgZGlzcGxheTogZmxleDsKICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKICAgIHotaW5kZXg6IDEwMDAwOwogICAgcGFkZGluZzogMjBweDsKICB9CiAgLmF1dGgtY2FyZCB7CiAgICBiYWNrZ3JvdW5kOiB2YXIoLS1jYXJkLWJnKTsKICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgICBib3JkZXItcmFkaXVzOiAxNnB4OwogICAgcGFkZGluZzogNDBweCAzNnB4OwogICAgd2lkdGg6IDEwMCU7CiAgICBtYXgtd2lkdGg6IDM4MHB4OwogICAgdGV4dC1hbGlnbjogY2VudGVyOwogICAgYm94LXNoYWRvdzogMCAyNHB4IDY0cHggcmdiYSgwLDAsMCwwLjUpOwogICAgYW5pbWF0aW9uOiBmYWRlVXAgMC40cyBlYXNlOwogIH0KICAuYXV0aC1pY29uIHsKICAgIGZvbnQtc2l6ZTogNDBweDsKICAgIG1hcmdpbi1ib3R0b206IDE2cHg7CiAgfQogIC5hdXRoLXRpdGxlIHsKICAgIGZvbnQtc2l6ZTogMjJweDsKICAgIGZvbnQtd2VpZ2h0OiA3MDA7CiAgICBtYXJnaW4tYm90dG9tOiA4cHg7CiAgICBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCB2YXIoLS1hY2NlbnQpLCAjYTc4YmZhKTsKICAgIC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOiB0ZXh0OwogICAgLXdlYmtpdC10ZXh0LWZpbGwtY29sb3I6IHRyYW5zcGFyZW50OwogICAgYmFja2dyb3VuZC1jbGlwOiB0ZXh0OwogIH0KICAuYXV0aC1kZXNjIHsKICAgIGZvbnQtc2l6ZTogMTNweDsKICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTsKICAgIG1hcmdpbi1ib3R0b206IDI0cHg7CiAgICBsaW5lLWhlaWdodDogMS41OwogIH0KICAuYXV0aC1pbnB1dCB7CiAgICB3aWR0aDogMTAwJTsKICAgIHBhZGRpbmc6IDEycHggMTZweDsKICAgIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgICBib3JkZXItcmFkaXVzOiAxMHB4OwogICAgZm9udC1zaXplOiAxNXB4OwogICAgb3V0bGluZTogbm9uZTsKICAgIHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAwLjJzOwogICAgbWFyZ2luLWJvdHRvbTogMTRweDsKICAgIHRleHQtYWxpZ246IGNlbnRlcjsKICB9CiAgLmF1dGgtaW5wdXQ6Zm9jdXMgeyBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7IH0KICAuYXV0aC1idG4gewogICAgd2lkdGg6IDEwMCU7CiAgICBwYWRkaW5nOiAxMnB4OwogICAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgdmFyKC0tYWNjZW50KSwgIzZkNWNlNik7CiAgICBjb2xvcjogI2ZmZjsKICAgIGJvcmRlcjogbm9uZTsKICAgIGJvcmRlci1yYWRpdXM6IDEwcHg7CiAgICBmb250LXNpemU6IDE1cHg7CiAgICBmb250LXdlaWdodDogNjAwOwogICAgY3Vyc29yOiBwb2ludGVyOwogICAgdHJhbnNpdGlvbjogYWxsIDAuMnM7CiAgfQogIC5hdXRoLWJ0bjpob3ZlciB7CiAgICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoLTFweCk7CiAgICBib3gtc2hhZG93OiAwIDZweCAyMHB4IHZhcigtLWFjY2VudC1nbG93KTsKICB9CiAgLmF1dGgtZXJyb3IgewogICAgY29sb3I6IHZhcigtLWRhbmdlcik7CiAgICBmb250LXNpemU6IDEzcHg7CiAgICBtYXJnaW4tdG9wOiAxMnB4OwogICAgbWluLWhlaWdodDogMThweDsKICB9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8ZGl2IGNsYXNzPSJjb250YWluZXIiPgogIDwhLS0g5aS06YOoIC0tPgogIDxkaXYgY2xhc3M9ImhlYWRlciI+CiAgICA8aDE+5om56YeP562+5Yiw5bel5YW3PC9oMT4KICAgIDxwPuWkmui0puWPt+iHquWKqOeZu+W9leW5tuWujOaIkOavj+aXpeetvuWIsDwvcD4KICAgIDxkaXYgY2xhc3M9InN0YXR1cy1iYWRnZSBvZmZsaW5lIiBpZD0ic2VydmVyU3RhdHVzIj4KICAgICAgPHNwYW4gY2xhc3M9InN0YXR1cy1kb3QiPjwvc3Bhbj4KICAgICAgPHNwYW4gaWQ9InN0YXR1c1RleHQiPui/nuaOpeS4rS4uLjwvc3Bhbj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8IS0tIOi0puWPt+euoeeQhiAtLT4KICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgIDxkaXYgY2xhc3M9ImNhcmQtdGl0bGUiPui0puWPt+euoeeQhjwvZGl2PgoKICAgIDwhLS0g5a+G56CB5YiG57uE566h55CGIC0tPgogICAgPGRpdiBjbGFzcz0iZ3JvdXAtYmFyIiBpZD0iZ3JvdXBCYXIiPgogICAgICA8c3BhbiBjbGFzcz0iZ3JvdXAtYmFyLWxhYmVsIj7lr4bnoIHliIbnu4TvvJo8L3NwYW4+CiAgICAgIDxkaXYgaWQ9Imdyb3VwQ2hpcHMiIHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjZweDtmbGV4LXdyYXA6d3JhcDsiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJncm91cC1hZGQtYnRuIiBvbmNsaWNrPSJhZGRHcm91cCgpIj4rIOaWsOW7uuWIhue7hDwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8IS0tIOWIhue7hOe8lui+kemdouadvyAtLT4KICAgIDxkaXYgY2xhc3M9Imdyb3VwLWVkaXQtcGFuZWwiIGlkPSJncm91cEVkaXRQYW5lbCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPgogICAgICA8aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9Imdyb3VwLW5hbWUtaW5wdXQiIGlkPSJlZGl0R3JvdXBOYW1lIiBwbGFjZWhvbGRlcj0i5YiG57uE5ZCN56ewIj4KICAgICAgPGlucHV0IHR5cGU9InBhc3N3b3JkIiBjbGFzcz0iZ3JvdXAtcHdkLWlucHV0IiBpZD0iZWRpdEdyb3VwUHdkIiBwbGFjZWhvbGRlcj0i6K+l57uE5YWx55So5a+G56CBIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zZWNvbmRhcnkiIHN0eWxlPSJwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZToxMnB4OyIgb25jbGljaz0ic2F2ZUdyb3VwRWRpdCgpIj7kv53lrZg8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zZWNvbmRhcnkiIHN0eWxlPSJwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZToxMnB4OyIgb25jbGljaz0iY2FuY2VsR3JvdXBFZGl0KCkiPuWPlua2iDwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iYWNjb3VudC1saXN0IiBpZD0iYWNjb3VudExpc3QiPgogICAgICA8IS0tIOWKqOaAgeeUn+aIkCAtLT4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iYnRuLWdyb3VwIiBzdHlsZT0ibWFyZ2luLXRvcDogMTRweDsiPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXNlY29uZGFyeSIgb25jbGljaz0iYWRkQWNjb3VudCgpIj4rIOa3u+WKoOi0puWPtzwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXNlY29uZGFyeSIgb25jbGljaz0idG9nZ2xlSW1wb3J0KCkiPuaJuemHj+WvvOWFpTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXNlY29uZGFyeSIgb25jbGljaz0iZXhwb3J0QWNjb3VudHMoKSI+5a+85Ye66LSm5Y+3PC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZGFuZ2VyIiBvbmNsaWNrPSJjbGVhckFjY291bnRzKCkiPua4heepuuWFqOmDqDwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPCEtLSDmibnph4/lr7zlhaXljLrln58gLS0+CiAgICA8ZGl2IGlkPSJpbXBvcnRTZWN0aW9uIiBzdHlsZT0iZGlzcGxheTpub25lOyBtYXJnaW4tdG9wOiAxNnB4OyI+CiAgICAgIDx0ZXh0YXJlYSBjbGFzcz0iaW1wb3J0LWFyZWEiIGlkPSJpbXBvcnRUZXh0IiBwbGFjZWhvbGRlcj0i5q+P6KGM5LiA5Liq6LSm5Y+377yM5qC85byP77ya55So5oi35ZCNLOWvhueggSzljLrmnI3liJfooagmIzEwO+WMuuacjeWPr+Whq++8mmFsbO+8iOWFqOmDqO+8iSDmiJYgMSwzLDXvvIjmjIflrprljLrvvIkg5oiWIDHvvIjljZXkuKrljLrvvIkmIzEwO+S+i+Wmgu+8miYjMTA7dXNlcjAwMSwxMjM0NTYsYWxsJiMxMDt1c2VyMDAyLGFiY2RlZiwxLDMsNSI+PC90ZXh0YXJlYT4KICAgICAgPGRpdiBjbGFzcz0iaW1wb3J0LWhpbnQiPgogICAgICAgIOagvOW8j++8mjxjb2RlPueUqOaIt+WQjSzlr4bnoIEs5Yy65pyN5YiX6KGoPC9jb2RlPu+8jOavj+ihjOS4gOS4quOAguWMuuacjeWhqyA8Y29kZT5hbGw8L2NvZGU+IOihqOekuuWFqOmDqDfljLrvvIzmiJbloavlhbfkvZPnvJblj7flpoIgPGNvZGU+MSwzLDU8L2NvZGU+44CCCiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJidG4tZ3JvdXAiIHN0eWxlPSJtYXJnaW4tdG9wOiAxMHB4OyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBvbmNsaWNrPSJkb0ltcG9ydCgpIj7noa7orqTlr7zlhaU8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXNlY29uZGFyeSIgb25jbGljaz0idG9nZ2xlSW1wb3J0KCkiPuWPlua2iDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8IS0tIOetvuWIsOiuvue9ruS4juaJp+ihjCAtLT4KICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgIDxkaXYgY2xhc3M9ImNhcmQtdGl0bGUiPuetvuWIsOiuvue9rjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2V0dGluZ3Mtcm93Ij4KICAgICAgPGxhYmVsPgogICAgICAgIOi0puWPt+mXtOmalO+8mgogICAgICAgIDxpbnB1dCB0eXBlPSJudW1iZXIiIGlkPSJkZWxheUlucHV0IiB2YWx1ZT0iMTUwMCIgbWluPSIwIiBtYXg9IjEwMDAwIiBzdGVwPSIxMDAiPgogICAgICAgIOavq+enkgogICAgICA8L2xhYmVsPgogICAgICA8c3BhbiBzdHlsZT0iY29sb3I6IHZhcigtLXRleHQtbXV0ZWQpOyBmb250LXNpemU6IDEycHg7Ij7vvIjlu7rorq4gMTAwMG1zIOS7peS4iu+8jOmBv+WFjeivt+axgui/h+W/q++8iTwvc3Bhbj4KICAgIDwvZGl2PgoKICAgIDwhLS0g6L+b5bqm5p2hIC0tPgogICAgPGRpdiBjbGFzcz0icHJvZ3Jlc3Mtd3JhcCIgaWQ9InByb2dyZXNzV3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6IDE4cHg7Ij4KICAgICAgPGRpdiBjbGFzcz0icHJvZ3Jlc3MtaW5mbyI+CiAgICAgICAgPHNwYW4gY2xhc3M9ImN1cnJlbnQiIGlkPSJwcm9ncmVzc1RleHQiPuWHhuWkh+S4rS4uLjwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0icHJvZ3Jlc3NQZXJjZW50Ij4wJTwvc3Bhbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InByb2dyZXNzLWJhciI+CiAgICAgICAgPGRpdiBjbGFzcz0icHJvZ3Jlc3MtZmlsbCIgaWQ9InByb2dyZXNzRmlsbCI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IGJ0bi1sZyIgaWQ9InN0YXJ0QnRuIiBvbmNsaWNrPSJzdGFydEJhdGNoKCkiIHN0eWxlPSJtYXJnaW4tdG9wOiAxOHB4OyI+CiAgICAgIOW8gOWni+aJuemHj+etvuWIsAogICAgPC9idXR0b24+CiAgPC9kaXY+CgogIDwhLS0g562+5Yiw57uT5p6cIC0tPgogIDxkaXYgY2xhc3M9ImNhcmQiIGlkPSJyZXN1bHRDYXJkIiBzdHlsZT0iZGlzcGxheTpub25lOyI+CiAgICA8ZGl2IGNsYXNzPSJjYXJkLXRpdGxlIj7nrb7liLDnu5Pmnpw8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRzLWdyaWQiIGlkPSJzdGF0c0dyaWQiPgogICAgICA8ZGl2IGNsYXNzPSJzdGF0LWNhcmQgdG90YWwiPgogICAgICAgIDxkaXYgY2xhc3M9InN0YXQtdmFsdWUiIGlkPSJzdGF0VG90YWwiPjA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0LWxhYmVsIj7mgLvotKblj7c8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQtY2FyZCBzdWNjZXNzIj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0LXZhbHVlIiBpZD0ic3RhdFN1Y2Nlc3MiPjA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0LWxhYmVsIj7nrb7liLDmiJDlip88L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQtY2FyZCBmYWlsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0LXZhbHVlIiBpZD0ic3RhdEZhaWwiPjA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0LWxhYmVsIj7nrb7liLDlpLHotKU8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQtY2FyZCBwZW5kaW5nIj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0LXZhbHVlIiBpZD0ic3RhdFBlbmRpbmciPjA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0LWxhYmVsIj7nrYnlvoXkuK08L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgc3R5bGU9Im92ZXJmbG93LXg6IGF1dG87Ij4KICAgICAgPHRhYmxlIGNsYXNzPSJyZXN1bHQtdGFibGUiPgogICAgICAgIDx0aGVhZD4KICAgICAgICAgIDx0cj4KICAgICAgICAgICAgPHRoPiM8L3RoPgogICAgICAgICAgICA8dGg+6LSm5Y+3PC90aD4KICAgICAgICAgICAgPHRoPuWMuuacjTwvdGg+CiAgICAgICAgICAgIDx0aD7nirbmgIE8L3RoPgogICAgICAgICAgICA8dGg+5raI5oGvPC90aD4KICAgICAgICAgIDwvdHI+CiAgICAgICAgPC90aGVhZD4KICAgICAgICA8dGJvZHkgaWQ9InJlc3VsdEJvZHkiPgogICAgICAgIDwvdGJvZHk+CiAgICAgIDwvdGFibGU+CiAgICA8L2Rpdj4KICA8L2Rpdj4KPC9kaXY+Cgo8IS0tIFRvYXN0IOWuueWZqCAtLT4KPGRpdiBjbGFzcz0idG9hc3QtY29udGFpbmVyIiBpZD0idG9hc3RDb250YWluZXIiPjwvZGl2PgoKPCEtLSDnmbvlvZXpga7nvanvvIjkupHmnI3liqHlmajpg6jnvbLml7bpnIDopoHlr4bnoIHorr/pl67vvIkgLS0+CjxkaXYgY2xhc3M9ImF1dGgtbWFzayIgaWQ9ImF1dGhNYXNrIiBzdHlsZT0iZGlzcGxheTpub25lOyI+CiAgPGRpdiBjbGFzcz0iYXV0aC1jYXJkIj4KICAgIDxkaXYgY2xhc3M9ImF1dGgtaWNvbiI+8J+UkjwvZGl2PgogICAgPGgyIGNsYXNzPSJhdXRoLXRpdGxlIj7orr/pl67pqozor4E8L2gyPgogICAgPHAgY2xhc3M9ImF1dGgtZGVzYyI+5q2k5pyN5Yqh5bey6K6+572u6K6/6Zeu5a+G56CB77yM6K+36L6T5YWl5a+G56CB5ZCO57un57utPC9wPgogICAgPGlucHV0IHR5cGU9InBhc3N3b3JkIiBjbGFzcz0iYXV0aC1pbnB1dCIgaWQ9ImF1dGhQYXNzd29yZCIgcGxhY2Vob2xkZXI9Iuivt+i+k+WFpeiuv+mXruWvhueggSIgb25rZXlkb3duPSJpZihldmVudC5rZXk9PT0nRW50ZXInKWRvQXV0aExvZ2luKCkiPgogICAgPGJ1dHRvbiBjbGFzcz0iYXV0aC1idG4iIG9uY2xpY2s9ImRvQXV0aExvZ2luKCkiPui/m+WFpeW3peWFtzwvYnV0dG9uPgogICAgPHAgY2xhc3M9ImF1dGgtZXJyb3IiIGlkPSJhdXRoRXJyb3IiPjwvcD4KICA8L2Rpdj4KPC9kaXY+Cgo8c2NyaXB0PgovLyA9PT09PT09PT09IOWFqOWxgOeKtuaAgSA9PT09PT09PT09CmNvbnN0IFNFUlZFUl9CQVNFID0gd2luZG93LmxvY2F0aW9uLm9yaWdpbjsKbGV0IGFjY291bnRzID0gW107CmxldCBpc1J1bm5pbmcgPSBmYWxzZTsKbGV0IHJlc3VsdERhdGEgPSBbXTsKbGV0IGF1dGhUb2tlbiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdiYXRjaF9zaWduaW5fdG9rZW4nKSB8fCAnJzsKCmNvbnN0IFNFUlZFUl9OQU1FUyA9IFsn5LiA5Yy6JywgJ+S6jOWMuicsICfkuInljLonLCAn5Zub5Yy6JywgJ+S6lOWMuicsICflha3ljLonLCAn5LiD5Yy6J107CmNvbnN0IEFMTF9TRVJWRVJTID0gWzEsIDIsIDMsIDQsIDUsIDYsIDddOwoKLy8g5a+G56CB5YiG57uECmxldCBwYXNzd29yZEdyb3VwcyA9IFtdOwpsZXQgZWRpdGluZ0dyb3VwSWQgPSBudWxsOwoKLy8g6I635Y+W6LSm5Y+355qE5Yy65pyN5YiX6KGo77yI5YW85a655pen5qC85byP77yJCmZ1bmN0aW9uIGdldEFjY291bnRTZXJ2ZXJzKGFjYykgewogIGlmIChBcnJheS5pc0FycmF5KGFjYy5zZXJ2ZXJzKSAmJiBhY2Muc2VydmVycy5sZW5ndGggPiAwKSB7CiAgICByZXR1cm4gYWNjLnNlcnZlcnMubWFwKHMgPT4gcGFyc2VJbnQocykpLmZpbHRlcihzID0+IHMgPj0gMSAmJiBzIDw9IDcpOwogIH0KICBpZiAoYWNjLnNlcnZlcmlkKSB7CiAgICByZXR1cm4gW3BhcnNlSW50KGFjYy5zZXJ2ZXJpZCldOwogIH0KICByZXR1cm4gWy4uLkFMTF9TRVJWRVJTXTsKfQoKLy8gPT09PT09PT09PSDpibTmnYPnm7jlhbMgPT09PT09PT09PQphc3luYyBmdW5jdGlvbiBhcGlGZXRjaCh1cmwsIG9wdGlvbnMgPSB7fSkgewogIGNvbnN0IGhlYWRlcnMgPSB7IC4uLihvcHRpb25zLmhlYWRlcnMgfHwge30pIH07CiAgaWYgKGF1dGhUb2tlbikgewogICAgaGVhZGVyc1snQXV0aG9yaXphdGlvbiddID0gJ0JlYXJlciAnICsgYXV0aFRva2VuOwogIH0KICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChTRVJWRVJfQkFTRSArIHVybCwgeyAuLi5vcHRpb25zLCBoZWFkZXJzIH0pOwogIGlmIChyZXMuc3RhdHVzID09PSA0MDEpIHsKICAgIGF1dGhUb2tlbiA9ICcnOwogICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oJ2JhdGNoX3NpZ25pbl90b2tlbicpOwogICAgc2hvd0F1dGhNYXNrKCk7CiAgICB0aHJvdyBuZXcgRXJyb3IoJ+acquaOiOadg++8jOivt+mHjeaWsOeZu+W9lScpOwogIH0KICByZXR1cm4gcmVzOwp9Cgphc3luYyBmdW5jdGlvbiBjaGVja0F1dGhSZXF1aXJlbWVudCgpIHsKICB0cnkgewogICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goU0VSVkVSX0JBU0UgKyAnL2FwaS9jb25maWcnKTsKICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpOwogICAgaWYgKGRhdGEucmVxdWlyZUF1dGggJiYgIWF1dGhUb2tlbikgewogICAgICBzaG93QXV0aE1hc2soKTsKICAgICAgcmV0dXJuIGZhbHNlOwogICAgfQogICAgLy8g5aaC5p6c5pyJIHRva2VuIOS9huacjeWKoeerr+S4jemcgOimgeWvhuegge+8jOa4hemZpCB0b2tlbgogICAgaWYgKCFkYXRhLnJlcXVpcmVBdXRoICYmIGF1dGhUb2tlbikgewogICAgICBhdXRoVG9rZW4gPSAnJzsKICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oJ2JhdGNoX3NpZ25pbl90b2tlbicpOwogICAgfQogICAgaGlkZUF1dGhNYXNrKCk7CiAgICByZXR1cm4gdHJ1ZTsKICB9IGNhdGNoIChlKSB7CiAgICByZXR1cm4gdHJ1ZTsgLy8g6YWN572u5o6l5Y+j5LiN5Y+v55So5pe25LiN5oum5oiqCiAgfQp9CgpmdW5jdGlvbiBzaG93QXV0aE1hc2soKSB7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1dGhNYXNrJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4JzsKfQoKZnVuY3Rpb24gaGlkZUF1dGhNYXNrKCkgewogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhdXRoTWFzaycpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7Cn0KCmFzeW5jIGZ1bmN0aW9uIGRvQXV0aExvZ2luKCkgewogIGNvbnN0IHBhc3N3b3JkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1dGhQYXNzd29yZCcpLnZhbHVlOwogIGNvbnN0IGVycm9yRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXV0aEVycm9yJyk7CiAgaWYgKCFwYXNzd29yZCkgewogICAgZXJyb3JFbC50ZXh0Q29udGVudCA9ICfor7fovpPlhaXlr4bnoIEnOwogICAgcmV0dXJuOwogIH0KICB0cnkgewogICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goU0VSVkVSX0JBU0UgKyAnL2FwaS9hdXRoJywgewogICAgICBtZXRob2Q6ICdQT1NUJywKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcGFzc3dvcmQgfSkKICAgIH0pOwogICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7CiAgICBpZiAoZGF0YS5zdWNjZXNzICYmIGRhdGEudG9rZW4pIHsKICAgICAgYXV0aFRva2VuID0gZGF0YS50b2tlbjsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2JhdGNoX3NpZ25pbl90b2tlbicsIGF1dGhUb2tlbik7CiAgICAgIGhpZGVBdXRoTWFzaygpOwogICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXV0aFBhc3N3b3JkJykudmFsdWUgPSAnJzsKICAgICAgZXJyb3JFbC50ZXh0Q29udGVudCA9ICcnOwogICAgICBzaG93VG9hc3QoJ+eZu+W9leaIkOWKnycsICdzdWNjZXNzJyk7CiAgICB9IGVsc2UgewogICAgICBlcnJvckVsLnRleHRDb250ZW50ID0gZGF0YS5lcnJvciB8fCAn55m75b2V5aSx6LSlJzsKICAgIH0KICB9IGNhdGNoIChlKSB7CiAgICBlcnJvckVsLnRleHRDb250ZW50ID0gJ+e9kee7nOmUmeivr++8jOivt+mHjeivlSc7CiAgfQp9CgovLyA9PT09PT09PT09IOWIneWni+WMliA9PT09PT09PT09CmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBhc3luYyAoKSA9PiB7CiAgbG9hZFBhc3N3b3JkR3JvdXBzKCk7CiAgbG9hZEFjY291bnRzKCk7CiAgcmVuZGVyQWNjb3VudHMoKTsKICBhd2FpdCBjaGVja0F1dGhSZXF1aXJlbWVudCgpOwogIGNoZWNrU2VydmVyU3RhdHVzKCk7CiAgc2V0SW50ZXJ2YWwoY2hlY2tTZXJ2ZXJTdGF0dXMsIDE1MDAwKTsKfSk7CgovLyA9PT09PT09PT09IOacjeWKoeeKtuaAgSA9PT09PT09PT09CmFzeW5jIGZ1bmN0aW9uIGNoZWNrU2VydmVyU3RhdHVzKCkgewogIHRyeSB7CiAgICBjb25zdCByZXMgPSBhd2FpdCBhcGlGZXRjaCgnL2FwaS9zdGF0dXMnKTsKICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpOwogICAgaWYgKGRhdGEuc3RhdHVzID09PSAnb2snKSB7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZXJ2ZXJTdGF0dXMnKS5jbGFzc05hbWUgPSAnc3RhdHVzLWJhZGdlIG9ubGluZSc7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXNUZXh0JykudGV4dENvbnRlbnQgPSAn5pyN5Yqh5bey6L+e5o6lJzsKICAgIH0gZWxzZSB7CiAgICAgIHRocm93IG5ldyBFcnJvcign5byC5bi4Jyk7CiAgICB9CiAgfSBjYXRjaCAoZSkgewogICAgaWYgKGUubWVzc2FnZS5pbmNsdWRlcygn5pyq5o6I5p2DJykpIHJldHVybjsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZXJ2ZXJTdGF0dXMnKS5jbGFzc05hbWUgPSAnc3RhdHVzLWJhZGdlIG9mZmxpbmUnOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c1RleHQnKS50ZXh0Q29udGVudCA9ICfmnI3liqHmnKrov57mjqXvvIzor7flhYjlkK/liqggc2VydmVyLmpzJzsKICB9Cn0KCi8vID09PT09PT09PT0g6LSm5Y+3566h55CGID09PT09PT09PT0KZnVuY3Rpb24gbG9hZEFjY291bnRzKCkgewogIHRyeSB7CiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdiYXRjaF9zaWduaW5fYWNjb3VudHMnKTsKICAgIGlmIChzYXZlZCkgewogICAgICBhY2NvdW50cyA9IEpTT04ucGFyc2Uoc2F2ZWQpOwogICAgfQogIH0gY2F0Y2ggKGUpIHsKICAgIGFjY291bnRzID0gW107CiAgfQogIC8vIOi/geenu+aXp+agvOW8jyArIOehruS/neavj+S4qui0puWPt+mDveacieWMuuacjeWIl+ihqAogIGFjY291bnRzID0gYWNjb3VudHMubWFwKGFjYyA9PiB7CiAgICBjb25zdCBzZXJ2ZXJzID0gZ2V0QWNjb3VudFNlcnZlcnMoYWNjKTsKICAgIGNvbnN0IG1hcHBlZCA9IHsKICAgICAgYWNjb3VudDogYWNjLmFjY291bnQgfHwgJycsCiAgICAgIHB3ZDogYWNjLnB3ZCB8fCAnJywKICAgICAgc2VydmVyczogc2VydmVycy5sZW5ndGggPiAwID8gc2VydmVycyA6IFsuLi5BTExfU0VSVkVSU10KICAgIH07CiAgICAvLyDkv53nlZnlr4bnoIHliIbnu4RJRAogICAgaWYgKGFjYy5ncm91cElkKSBtYXBwZWQuZ3JvdXBJZCA9IGFjYy5ncm91cElkOwogICAgcmV0dXJuIG1hcHBlZDsKICB9KTsKICBpZiAoYWNjb3VudHMubGVuZ3RoID09PSAwKSB7CiAgICBhY2NvdW50cyA9IFt7IGFjY291bnQ6ICcnLCBwd2Q6ICcnLCBzZXJ2ZXJzOiBbLi4uQUxMX1NFUlZFUlNdIH1dOwogIH0KfQoKZnVuY3Rpb24gc2F2ZUFjY291bnRzKCkgewogIHRyeSB7CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnYmF0Y2hfc2lnbmluX2FjY291bnRzJywgSlNPTi5zdHJpbmdpZnkoYWNjb3VudHMpKTsKICB9IGNhdGNoIChlKSB7fQp9CgpmdW5jdGlvbiByZW5kZXJBY2NvdW50cygpIHsKICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FjY291bnRMaXN0Jyk7CiAgbGlzdC5pbm5lckhUTUwgPSAnJzsKICBhY2NvdW50cy5mb3JFYWNoKChhY2MsIGlkeCkgPT4gewogICAgY29uc3Qgc2VydmVycyA9IGdldEFjY291bnRTZXJ2ZXJzKGFjYyk7CiAgICBjb25zdCBpc0FsbCA9IHNlcnZlcnMubGVuZ3RoID09PSBBTExfU0VSVkVSUy5sZW5ndGg7CiAgICBjb25zdCB6b25lTGFiZWwgPSBpc0FsbCA/ICflhajpg6jljLrmnI0nIDogKHNlcnZlcnMubGVuZ3RoID09PSAwID8gJ+acqumAieaLqScgOiBzZXJ2ZXJzLmpvaW4oJywnKSArICfljLonKTsKICAgIGNvbnN0IGhhc0dyb3VwID0gISFhY2MuZ3JvdXBJZDsKCiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIHJvdy5jbGFzc05hbWUgPSAnYWNjb3VudC1yb3cnOwogICAgcm93LmlubmVySFRNTCA9IGAKICAgICAgPHNwYW4gY2xhc3M9ImlkeCI+JHtpZHggKyAxfTwvc3Bhbj4KICAgICAgPGlucHV0IHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSLnlKjmiLflkI0iIHZhbHVlPSIke2VzY2FwZUh0bWwoYWNjLmFjY291bnQpfSIgb25jaGFuZ2U9InVwZGF0ZUFjY291bnQoJHtpZHh9LCAnYWNjb3VudCcsIHRoaXMudmFsdWUpIj4KICAgICAgPGlucHV0IHR5cGU9InBhc3N3b3JkIiBjbGFzcz0icHdkLWZpZWxkICR7aGFzR3JvdXAgPyAnaW5kZXBlbmRlbnQtaGlkZGVuJyA6ICcnfSIgcGxhY2Vob2xkZXI9IuWvhueggSIgdmFsdWU9IiR7ZXNjYXBlSHRtbChhY2MucHdkKX0iIG9uY2hhbmdlPSJ1cGRhdGVBY2NvdW50KCR7aWR4fSwgJ3B3ZCcsIHRoaXMudmFsdWUpIj4KICAgICAgPHNlbGVjdCBjbGFzcz0iZ3JvdXAtc2VsZWN0IiBvbmNoYW5nZT0idXBkYXRlQWNjb3VudEdyb3VwKCR7aWR4fSwgdGhpcy52YWx1ZSkiPgogICAgICAgIDxvcHRpb24gdmFsdWU9IiI+54us56uL5a+G56CBPC9vcHRpb24+CiAgICAgICAgJHtwYXNzd29yZEdyb3Vwcy5tYXAoZyA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtnLmlkfSIgJHthY2MuZ3JvdXBJZCA9PT0gZy5pZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2NhcGVIdG1sKGcubmFtZSl9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICAgIDwvc2VsZWN0PgogICAgICA8ZGl2IGNsYXNzPSJ6b25lLXNlbGVjdCI+CiAgICAgICAgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJ6b25lLWJ0biIgb25jbGljaz0idG9nZ2xlWm9uZVBhbmVsKCR7aWR4fSwgZXZlbnQpIj4KICAgICAgICAgIDxzcGFuPiR7em9uZUxhYmVsfTwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ6b25lLWNvdW50Ij4ke3NlcnZlcnMubGVuZ3RofTwvc3Bhbj4KICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8ZGl2IGNsYXNzPSJ6b25lLXBhbmVsIiBpZD0iem9uZVBhbmVsLSR7aWR4fSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ6b25lLXBhbmVsLXRpdGxlIj4KICAgICAgICAgICAgPHNwYW4+6YCJ5oup5Yy65pyNPC9zcGFuPgogICAgICAgICAgICA8YSBvbmNsaWNrPSJ0b2dnbGVBbGxab25lcygke2lkeH0pIj4ke2lzQWxsID8gJ+WPlua2iOWFqOmAiScgOiAn5YWo6YCJJ308L2E+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InpvbmUtZ3JpZCI+CiAgICAgICAgICAgICR7QUxMX1NFUlZFUlMubWFwKHMgPT4gYAogICAgICAgICAgICAgIDxkaXYgY2xhc3M9InpvbmUtaXRlbSAke3NlcnZlcnMuaW5jbHVkZXMocykgPyAnYWN0aXZlJyA6ICcnfSIgb25jbGljaz0idG9nZ2xlWm9uZSgke2lkeH0sICR7c30pIj4KICAgICAgICAgICAgICAgICR7c33ljLoKICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgYCkuam9pbignJyl9CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1kZWwiIG9uY2xpY2s9InJlbW92ZUFjY291bnQoJHtpZHh9KSIgdGl0bGU9IuWIoOmZpCI+w5c8L2J1dHRvbj4KICAgIGA7CiAgICBsaXN0LmFwcGVuZENoaWxkKHJvdyk7CiAgfSk7Cn0KCmZ1bmN0aW9uIHVwZGF0ZUFjY291bnRHcm91cChpZHgsIGdyb3VwSWQpIHsKICBpZiAoZ3JvdXBJZCkgewogICAgYWNjb3VudHNbaWR4XS5ncm91cElkID0gZ3JvdXBJZDsKICB9IGVsc2UgewogICAgZGVsZXRlIGFjY291bnRzW2lkeF0uZ3JvdXBJZDsKICB9CiAgc2F2ZUFjY291bnRzKCk7CiAgcmVuZGVyQWNjb3VudHMoKTsKfQoKLy8g54K55Ye76aG16Z2i5YW25LuW5Yy65Z+f5YWz6Zet5omA5pyJ5Yy65pyN6YCJ5oup6Z2i5p2/CmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGUpID0+IHsKICBpZiAoIWUudGFyZ2V0LmNsb3Nlc3QoJy56b25lLXNlbGVjdCcpKSB7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuem9uZS1wYW5lbC5zaG93JykuZm9yRWFjaChwID0+IHAuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpKTsKICB9Cn0pOwoKZnVuY3Rpb24gdG9nZ2xlWm9uZVBhbmVsKGlkeCwgZXZlbnQpIHsKICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTsKICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd6b25lUGFuZWwtJyArIGlkeCk7CiAgY29uc3Qgd2FzT3BlbiA9IHBhbmVsLmNsYXNzTGlzdC5jb250YWlucygnc2hvdycpOwogIC8vIOWFiOWFs+mXreaJgOaciQogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy56b25lLXBhbmVsLnNob3cnKS5mb3JFYWNoKHAgPT4gcC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93JykpOwogIGlmICghd2FzT3BlbikgewogICAgcGFuZWwuY2xhc3NMaXN0LmFkZCgnc2hvdycpOwogIH0KfQoKZnVuY3Rpb24gdG9nZ2xlWm9uZShpZHgsIHNlcnZlck51bSkgewogIGNvbnN0IHNlcnZlcnMgPSBnZXRBY2NvdW50U2VydmVycyhhY2NvdW50c1tpZHhdKTsKICBjb25zdCBwb3MgPSBzZXJ2ZXJzLmluZGV4T2Yoc2VydmVyTnVtKTsKICBpZiAocG9zID4gLTEpIHsKICAgIHNlcnZlcnMuc3BsaWNlKHBvcywgMSk7CiAgfSBlbHNlIHsKICAgIHNlcnZlcnMucHVzaChzZXJ2ZXJOdW0pOwogICAgc2VydmVycy5zb3J0KChhLCBiKSA9PiBhIC0gYik7CiAgfQogIGlmIChzZXJ2ZXJzLmxlbmd0aCA9PT0gMCkgewogICAgLy8g5LiN5YWB6K645YWo6YOo5Y+W5raI77yM6Iez5bCR5L+d55WZ5LiA5LiqCiAgICBzZXJ2ZXJzLnB1c2goc2VydmVyTnVtKTsKICB9CiAgYWNjb3VudHNbaWR4XS5zZXJ2ZXJzID0gc2VydmVyczsKICBkZWxldGUgYWNjb3VudHNbaWR4XS5zZXJ2ZXJpZDsKICBzYXZlQWNjb3VudHMoKTsKICByZW5kZXJBY2NvdW50cygpOwogIC8vIOS/neaMgemdouadv+aJk+W8gAogIHNldFRpbWVvdXQoKCkgPT4gewogICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnem9uZVBhbmVsLScgKyBpZHgpOwogICAgaWYgKHBhbmVsKSBwYW5lbC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7CiAgfSwgMTApOwp9CgpmdW5jdGlvbiB0b2dnbGVBbGxab25lcyhpZHgpIHsKICBjb25zdCBzZXJ2ZXJzID0gZ2V0QWNjb3VudFNlcnZlcnMoYWNjb3VudHNbaWR4XSk7CiAgaWYgKHNlcnZlcnMubGVuZ3RoID09PSBBTExfU0VSVkVSUy5sZW5ndGgpIHsKICAgIGFjY291bnRzW2lkeF0uc2VydmVycyA9IFsxXTsgLy8g5Y+W5raI5YWo6YCJ5ZCO6buY6K6k5L+d55WZMeWMugogIH0gZWxzZSB7CiAgICBhY2NvdW50c1tpZHhdLnNlcnZlcnMgPSBbLi4uQUxMX1NFUlZFUlNdOwogIH0KICBkZWxldGUgYWNjb3VudHNbaWR4XS5zZXJ2ZXJpZDsKICBzYXZlQWNjb3VudHMoKTsKICByZW5kZXJBY2NvdW50cygpOwogIHNldFRpbWVvdXQoKCkgPT4gewogICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnem9uZVBhbmVsLScgKyBpZHgpOwogICAgaWYgKHBhbmVsKSBwYW5lbC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7CiAgfSwgMTApOwp9CgovLyA9PT09PT09PT09IOWvhueggeWIhue7hOeuoeeQhiA9PT09PT09PT09CmZ1bmN0aW9uIGxvYWRQYXNzd29yZEdyb3VwcygpIHsKICB0cnkgewogICAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnYmF0Y2hfc2lnbmluX2dyb3VwcycpOwogICAgcGFzc3dvcmRHcm91cHMgPSBzYXZlZCA/IEpTT04ucGFyc2Uoc2F2ZWQpIDogW107CiAgfSBjYXRjaCAoZSkgewogICAgcGFzc3dvcmRHcm91cHMgPSBbXTsKICB9CiAgcmVuZGVyR3JvdXBDaGlwcygpOwp9CgpmdW5jdGlvbiBzYXZlUGFzc3dvcmRHcm91cHMoKSB7CiAgdHJ5IHsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdiYXRjaF9zaWduaW5fZ3JvdXBzJywgSlNPTi5zdHJpbmdpZnkocGFzc3dvcmRHcm91cHMpKTsKICB9IGNhdGNoIChlKSB7fQp9CgpmdW5jdGlvbiByZW5kZXJHcm91cENoaXBzKCkgewogIGNvbnN0IGNvbnRhaW5lciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdncm91cENoaXBzJyk7CiAgaWYgKCFjb250YWluZXIpIHJldHVybjsKICBjb250YWluZXIuaW5uZXJIVE1MID0gcGFzc3dvcmRHcm91cHMubWFwKGcgPT4gYAogICAgPHNwYW4gY2xhc3M9Imdyb3VwLWNoaXAiIG9uY2xpY2s9ImVkaXRHcm91cCgnJHtnLmlkfScpIiB0aXRsZT0i54K55Ye757yW6L6RIj4KICAgICAgPHNwYW4gY2xhc3M9Imdyb3VwLW5hbWUiPiR7ZXNjYXBlSHRtbChnLm5hbWUpfTwvc3Bhbj4KICAgICAgPHNwYW4gY2xhc3M9Imdyb3VwLXB3ZCI+JHtnLnBhc3N3b3JkID8gJ+KAouKAouKAouKAoicgOiAn5peg5a+G56CBJ308L3NwYW4+CiAgICAgIDxzcGFuIGNsYXNzPSJncm91cC1kZWwiIG9uY2xpY2s9ImV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO2RlbGV0ZUdyb3VwKCcke2cuaWR9JykiPsOXPC9zcGFuPgogICAgPC9zcGFuPgogIGApLmpvaW4oJycpOwp9CgpmdW5jdGlvbiBhZGRHcm91cCgpIHsKICBjb25zdCBpZCA9ICdnXycgKyBEYXRlLm5vdygpOwogIGNvbnN0IG5ld0dyb3VwID0geyBpZCwgbmFtZTogJ+WIhue7hCcgKyAocGFzc3dvcmRHcm91cHMubGVuZ3RoICsgMSksIHBhc3N3b3JkOiAnJyB9OwogIHBhc3N3b3JkR3JvdXBzLnB1c2gobmV3R3JvdXApOwogIHNhdmVQYXNzd29yZEdyb3VwcygpOwogIHJlbmRlckdyb3VwQ2hpcHMoKTsKICAvLyDnm7TmjqXov5vlhaXnvJbovpEKICBlZGl0aW5nR3JvdXBJZCA9IGlkOwogIHNob3dHcm91cEVkaXRQYW5lbChuZXdHcm91cCk7Cn0KCmZ1bmN0aW9uIGVkaXRHcm91cChpZCkgewogIGNvbnN0IGdyb3VwID0gcGFzc3dvcmRHcm91cHMuZmluZChnID0+IGcuaWQgPT09IGlkKTsKICBpZiAoIWdyb3VwKSByZXR1cm47CiAgZWRpdGluZ0dyb3VwSWQgPSBpZDsKICBzaG93R3JvdXBFZGl0UGFuZWwoZ3JvdXApOwp9CgpmdW5jdGlvbiBzaG93R3JvdXBFZGl0UGFuZWwoZ3JvdXApIHsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ3JvdXBFZGl0UGFuZWwnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlZGl0R3JvdXBOYW1lJykudmFsdWUgPSBncm91cC5uYW1lOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlZGl0R3JvdXBQd2QnKS52YWx1ZSA9IGdyb3VwLnBhc3N3b3JkOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlZGl0R3JvdXBOYW1lJykuZm9jdXMoKTsKfQoKZnVuY3Rpb24gc2F2ZUdyb3VwRWRpdCgpIHsKICBpZiAoIWVkaXRpbmdHcm91cElkKSByZXR1cm47CiAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdlZGl0R3JvdXBOYW1lJykudmFsdWUudHJpbSgpIHx8ICfmnKrlkb3lkI0nOwogIGNvbnN0IHBhc3N3b3JkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2VkaXRHcm91cFB3ZCcpLnZhbHVlOwogIGNvbnN0IGdyb3VwID0gcGFzc3dvcmRHcm91cHMuZmluZChnID0+IGcuaWQgPT09IGVkaXRpbmdHcm91cElkKTsKICBpZiAoZ3JvdXApIHsKICAgIGdyb3VwLm5hbWUgPSBuYW1lOwogICAgZ3JvdXAucGFzc3dvcmQgPSBwYXNzd29yZDsKICAgIHNhdmVQYXNzd29yZEdyb3VwcygpOwogICAgcmVuZGVyR3JvdXBDaGlwcygpOwogICAgcmVuZGVyQWNjb3VudHMoKTsgLy8g5pu05paw6LSm5Y+36KGM55qE5YiG57uE5LiL5ouJCiAgfQogIGNhbmNlbEdyb3VwRWRpdCgpOwogIHNob3dUb2FzdCgn5YiG57uE5bey5L+d5a2YJywgJ3N1Y2Nlc3MnKTsKfQoKZnVuY3Rpb24gY2FuY2VsR3JvdXBFZGl0KCkgewogIGVkaXRpbmdHcm91cElkID0gbnVsbDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ3JvdXBFZGl0UGFuZWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwp9CgpmdW5jdGlvbiBkZWxldGVHcm91cChpZCkgewogIGNvbnN0IGdyb3VwID0gcGFzc3dvcmRHcm91cHMuZmluZChnID0+IGcuaWQgPT09IGlkKTsKICBpZiAoIWdyb3VwKSByZXR1cm47CiAgLy8g57uf6K6h5L2/55So6K+l5YiG57uE55qE6LSm5Y+35pWwCiAgY29uc3QgdXNlZENvdW50ID0gYWNjb3VudHMuZmlsdGVyKGEgPT4gYS5ncm91cElkID09PSBpZCkubGVuZ3RoOwogIGNvbnN0IG1zZyA9IHVzZWRDb3VudCA+IDAKICAgID8gYOehruWumuWIoOmZpOWIhue7hOOAjCR7Z3JvdXAubmFtZX3jgI3lkJfvvJ9cbuaciSAke3VzZWRDb3VudH0g5Liq6LSm5Y+35q2j5Zyo5L2/55So6K+l5YiG57uE77yM5Yig6Zmk5ZCO6L+Z5Lqb6LSm5Y+35bCG5pS55Li654us56uL5a+G56CB5qih5byP44CCYAogICAgOiBg56Gu5a6a5Yig6Zmk5YiG57uE44CMJHtncm91cC5uYW1lfeOAjeWQl++8n2A7CiAgaWYgKCFjb25maXJtKG1zZykpIHJldHVybjsKICAvLyDnp7vpmaTliIbnu4TvvIzkvb/nlKjor6XliIbnu4TnmoTotKblj7fmlLnkuLrni6znq4vlr4bnoIEKICBhY2NvdW50cy5mb3JFYWNoKGEgPT4gewogICAgaWYgKGEuZ3JvdXBJZCA9PT0gaWQpIGRlbGV0ZSBhLmdyb3VwSWQ7CiAgfSk7CiAgcGFzc3dvcmRHcm91cHMgPSBwYXNzd29yZEdyb3Vwcy5maWx0ZXIoZyA9PiBnLmlkICE9PSBpZCk7CiAgc2F2ZVBhc3N3b3JkR3JvdXBzKCk7CiAgc2F2ZUFjY291bnRzKCk7CiAgcmVuZGVyR3JvdXBDaGlwcygpOwogIHJlbmRlckFjY291bnRzKCk7CiAgaWYgKGVkaXRpbmdHcm91cElkID09PSBpZCkgY2FuY2VsR3JvdXBFZGl0KCk7CiAgc2hvd1RvYXN0KCfliIbnu4Tlt7LliKDpmaQnLCAnaW5mbycpOwp9CgovLyDojrflj5botKblj7fnmoTlrp7pmYXlr4bnoIHvvIjmnInliIbnu4TliJnnlKjliIbnu4Tlr4bnoIHvvIzlkKbliJnnlKjni6znq4vlr4bnoIHvvIkKZnVuY3Rpb24gZ2V0QWNjb3VudFBhc3N3b3JkKGFjYykgewogIGlmIChhY2MuZ3JvdXBJZCkgewogICAgY29uc3QgZ3JvdXAgPSBwYXNzd29yZEdyb3Vwcy5maW5kKGcgPT4gZy5pZCA9PT0gYWNjLmdyb3VwSWQpOwogICAgaWYgKGdyb3VwICYmIGdyb3VwLnBhc3N3b3JkKSByZXR1cm4gZ3JvdXAucGFzc3dvcmQ7CiAgfQogIHJldHVybiBhY2MucHdkIHx8ICcnOwp9CgovLyDojrflj5botKblj7fnmoTliIbnu4TlkI3np7AKZnVuY3Rpb24gZ2V0QWNjb3VudEdyb3VwTmFtZShhY2MpIHsKICBpZiAoIWFjYy5ncm91cElkKSByZXR1cm4gJ+eLrOeri+WvhueggSc7CiAgY29uc3QgZ3JvdXAgPSBwYXNzd29yZEdyb3Vwcy5maW5kKGcgPT4gZy5pZCA9PT0gYWNjLmdyb3VwSWQpOwogIHJldHVybiBncm91cCA/IGdyb3VwLm5hbWUgOiAn54us56uL5a+G56CBJzsKfQoKZnVuY3Rpb24gdXBkYXRlQWNjb3VudChpZHgsIGZpZWxkLCB2YWx1ZSkgewogIGFjY291bnRzW2lkeF1bZmllbGRdID0gdmFsdWU7CiAgc2F2ZUFjY291bnRzKCk7Cn0KCmZ1bmN0aW9uIGFkZEFjY291bnQoKSB7CiAgYWNjb3VudHMucHVzaCh7IGFjY291bnQ6ICcnLCBwd2Q6ICcnLCBzZXJ2ZXJzOiBbLi4uQUxMX1NFUlZFUlNdIH0pOwogIHNhdmVBY2NvdW50cygpOwogIHJlbmRlckFjY291bnRzKCk7Cn0KCmZ1bmN0aW9uIHJlbW92ZUFjY291bnQoaWR4KSB7CiAgaWYgKGFjY291bnRzLmxlbmd0aCA8PSAxKSB7CiAgICBhY2NvdW50cyA9IFt7IGFjY291bnQ6ICcnLCBwd2Q6ICcnLCBzZXJ2ZXJzOiBbLi4uQUxMX1NFUlZFUlNdIH1dOwogIH0gZWxzZSB7CiAgICBhY2NvdW50cy5zcGxpY2UoaWR4LCAxKTsKICB9CiAgc2F2ZUFjY291bnRzKCk7CiAgcmVuZGVyQWNjb3VudHMoKTsKfQoKZnVuY3Rpb24gY2xlYXJBY2NvdW50cygpIHsKICBpZiAoIWNvbmZpcm0oJ+ehruWumuimgea4heepuuaJgOaciei0puWPt+WQl++8nycpKSByZXR1cm47CiAgYWNjb3VudHMgPSBbeyBhY2NvdW50OiAnJywgcHdkOiAnJywgc2VydmVyczogWy4uLkFMTF9TRVJWRVJTXSB9XTsKICBzYXZlQWNjb3VudHMoKTsKICByZW5kZXJBY2NvdW50cygpOwogIHNob3dUb2FzdCgn5bey5riF56m6JywgJ2luZm8nKTsKfQoKLy8gPT09PT09PT09PSDmibnph4/lr7zlhaXlr7zlh7ogPT09PT09PT09PQpmdW5jdGlvbiB0b2dnbGVJbXBvcnQoKSB7CiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdpbXBvcnRTZWN0aW9uJyk7CiAgc2VjdGlvbi5zdHlsZS5kaXNwbGF5ID0gc2VjdGlvbi5zdHlsZS5kaXNwbGF5ID09PSAnbm9uZScgPyAnYmxvY2snIDogJ25vbmUnOwp9CgpmdW5jdGlvbiBkb0ltcG9ydCgpIHsKICBjb25zdCB0ZXh0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ltcG9ydFRleHQnKS52YWx1ZS50cmltKCk7CiAgaWYgKCF0ZXh0KSB7IHNob3dUb2FzdCgn6K+36L6T5YWl6LSm5Y+35pWw5o2uJywgJ2Vycm9yJyk7IHJldHVybjsgfQoKICBjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoJ1xuJykuZmlsdGVyKGwgPT4gbC50cmltKCkpOwogIGNvbnN0IGltcG9ydGVkID0gW107CiAgbGV0IGVycm9ycyA9IDA7CgogIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykgewogICAgY29uc3QgcGFydHMgPSBsaW5lLnNwbGl0KC9bLO+8jFx0XS8pLm1hcChzID0+IHMudHJpbSgpKTsKICAgIGlmIChwYXJ0cy5sZW5ndGggPj0gMyAmJiBwYXJ0c1swXSAmJiBwYXJ0c1sxXSkgewogICAgICBsZXQgc2VydmVycyA9IFtdOwogICAgICBjb25zdCB6b25lU3RyID0gcGFydHMuc2xpY2UoMikuam9pbignLCcpLnRvTG93ZXJDYXNlKCk7CgogICAgICBpZiAoem9uZVN0ciA9PT0gJ2FsbCcgfHwgem9uZVN0ciA9PT0gJ+WFqOmDqCcgfHwgem9uZVN0ciA9PT0gJ2FsbHpvbmUnKSB7CiAgICAgICAgc2VydmVycyA9IFsuLi5BTExfU0VSVkVSU107CiAgICAgIH0gZWxzZSB7CiAgICAgICAgLy8g6Kej5p6Q5aSa5Liq5Yy65pyN57yW5Y+3CiAgICAgICAgY29uc3Qgem9uZU51bXMgPSB6b25lU3RyLnNwbGl0KC9bLO+8jOOAgVxzXSsvKS5tYXAocyA9PiBwYXJzZUludChzKSkuZmlsdGVyKG4gPT4gbiA+PSAxICYmIG4gPD0gNyk7CiAgICAgICAgc2VydmVycyA9IHpvbmVOdW1zLmxlbmd0aCA+IDAgPyBbLi4ubmV3IFNldCh6b25lTnVtcyldLnNvcnQoKGEsYikgPT4gYS1iKSA6IFsuLi5BTExfU0VSVkVSU107CiAgICAgIH0KCiAgICAgIGltcG9ydGVkLnB1c2goewogICAgICAgIGFjY291bnQ6IHBhcnRzWzBdLAogICAgICAgIHB3ZDogcGFydHNbMV0sCiAgICAgICAgc2VydmVyczogc2VydmVycwogICAgICB9KTsKICAgIH0gZWxzZSB7CiAgICAgIGVycm9ycysrOwogICAgfQogIH0KCiAgaWYgKGltcG9ydGVkLmxlbmd0aCA9PT0gMCkgewogICAgc2hvd1RvYXN0KCfmnKrop6PmnpDliLDmnInmlYjotKblj7cnLCAnZXJyb3InKTsKICAgIHJldHVybjsKICB9CgogIC8vIOabv+aNouaIlui/veWKoO+8nwogIGlmIChhY2NvdW50cy5sZW5ndGggPiAwICYmIGFjY291bnRzLnNvbWUoYSA9PiBhLmFjY291bnQgfHwgYS5wd2QpKSB7CiAgICBpZiAoIWNvbmZpcm0oYOW3suino+aekCAke2ltcG9ydGVkLmxlbmd0aH0g5Liq6LSm5Y+344CC5piv5ZCm5pu/5o2i546w5pyJ6LSm5Y+35YiX6KGo77yf77yI5Y+W5raI5YiZ6L+95Yqg77yJYCkpIHsKICAgICAgYWNjb3VudHMgPSBhY2NvdW50cy5jb25jYXQoaW1wb3J0ZWQpOwogICAgfSBlbHNlIHsKICAgICAgYWNjb3VudHMgPSBpbXBvcnRlZDsKICAgIH0KICB9IGVsc2UgewogICAgYWNjb3VudHMgPSBpbXBvcnRlZDsKICB9CgogIHNhdmVBY2NvdW50cygpOwogIHJlbmRlckFjY291bnRzKCk7CiAgdG9nZ2xlSW1wb3J0KCk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ltcG9ydFRleHQnKS52YWx1ZSA9ICcnOwogIHNob3dUb2FzdChg5oiQ5Yqf5a+85YWlICR7aW1wb3J0ZWQubGVuZ3RofSDkuKrotKblj7cke2Vycm9ycyA+IDAgPyBg77yMJHtlcnJvcnN9IOihjOagvOW8j+mUmeivr2AgOiAnJ31gLCAnc3VjY2VzcycpOwp9CgpmdW5jdGlvbiBleHBvcnRBY2NvdW50cygpIHsKICBjb25zdCB2YWxpZCA9IGFjY291bnRzLmZpbHRlcihhID0+IGEuYWNjb3VudCAmJiBnZXRBY2NvdW50UGFzc3dvcmQoYSkpOwogIGlmICh2YWxpZC5sZW5ndGggPT09IDApIHsgc2hvd1RvYXN0KCfmsqHmnInlj6/lr7zlh7rnmoTotKblj7cnLCAnZXJyb3InKTsgcmV0dXJuOyB9CiAgY29uc3QgdGV4dCA9IHZhbGlkLm1hcChhID0+IHsKICAgIGNvbnN0IHNlcnZlcnMgPSBnZXRBY2NvdW50U2VydmVycyhhKTsKICAgIGNvbnN0IHpvbmVTdHIgPSBzZXJ2ZXJzLmxlbmd0aCA9PT0gQUxMX1NFUlZFUlMubGVuZ3RoID8gJ2FsbCcgOiBzZXJ2ZXJzLmpvaW4oJywnKTsKICAgIHJldHVybiBgJHthLmFjY291bnR9LCR7Z2V0QWNjb3VudFBhc3N3b3JkKGEpfSwke3pvbmVTdHJ9YDsKICB9KS5qb2luKCdcbicpOwogIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbdGV4dF0sIHsgdHlwZTogJ3RleHQvcGxhaW47Y2hhcnNldD11dGYtOCcgfSk7CiAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsKICBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYScpOwogIGEuaHJlZiA9IHVybDsKICBhLmRvd25sb2FkID0gJ+etvuWIsOi0puWPt+WIl+ihqC50eHQnOwogIGEuY2xpY2soKTsKICBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7CiAgc2hvd1RvYXN0KCflt7Llr7zlh7rotKblj7fliJfooagnLCAnc3VjY2VzcycpOwp9CgovLyA9PT09PT09PT09IOaJuemHj+etvuWIsCA9PT09PT09PT09CmFzeW5jIGZ1bmN0aW9uIHN0YXJ0QmF0Y2goKSB7CiAgaWYgKGlzUnVubmluZykgcmV0dXJuOwoKICBjb25zdCB2YWxpZEFjY291bnRzID0gYWNjb3VudHMuZmlsdGVyKGEgPT4gYS5hY2NvdW50ICYmIGdldEFjY291bnRQYXNzd29yZChhKSAmJiBnZXRBY2NvdW50U2VydmVycyhhKS5sZW5ndGggPiAwKTsKICBpZiAodmFsaWRBY2NvdW50cy5sZW5ndGggPT09IDApIHsKICAgIC8vIOajgOafpeaYr+WQpuaciei0puWPt+eUqOS6huaXoOWvhueggeeahOWIhue7hAogICAgY29uc3Qgbm9Qd2RHcm91cHMgPSBhY2NvdW50cy5maWx0ZXIoYSA9PiBhLmdyb3VwSWQgJiYgIWdldEFjY291bnRQYXNzd29yZChhKSk7CiAgICBpZiAobm9Qd2RHcm91cHMubGVuZ3RoID4gMCkgewogICAgICBzaG93VG9hc3QoJ+aciei0puWPt+aJgOWxnueahOWvhueggeWIhue7hOacquiuvue9ruWvhuegge+8jOivt+WFiOe8lui+keWIhue7hOWhq+WGmeWvhueggScsICdlcnJvcicpOwogICAgfSBlbHNlIHsKICAgICAgc2hvd1RvYXN0KCfor7flhYjloavlhpnoh7PlsJHkuIDkuKrmnInmlYjotKblj7cnLCAnZXJyb3InKTsKICAgIH0KICAgIHJldHVybjsKICB9CgogIC8vIOaehOmAoOWPkemAgee7meWQjuerr+eahOi0puWPt+WIl+ihqO+8iOazqOWFpeWunumZheWvhuegge+8iQogIGNvbnN0IHNlbmRBY2NvdW50cyA9IHZhbGlkQWNjb3VudHMubWFwKGEgPT4gKHsKICAgIGFjY291bnQ6IGEuYWNjb3VudCwKICAgIHB3ZDogZ2V0QWNjb3VudFBhc3N3b3JkKGEpLAogICAgc2VydmVyczogZ2V0QWNjb3VudFNlcnZlcnMoYSkKICB9KSk7CgogIGlzUnVubmluZyA9IHRydWU7CiAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXJ0QnRuJyk7CiAgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICBidG4udGV4dENvbnRlbnQgPSAn562+5Yiw6L+b6KGM5LitLi4uJzsKCiAgY29uc3QgZGVsYXkgPSBwYXJzZUludChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZGVsYXlJbnB1dCcpLnZhbHVlKSB8fCAxNTAwOwoKICAvLyDlsZXlvIDkuLrotKblj7fDl+WMuuacjeeahOS7u+WKoeWIl+ihqO+8jOeUqOS6jue7k+aenOWxleekugogIGNvbnN0IHRvdGFsVGFza3MgPSBbXTsKICB2YWxpZEFjY291bnRzLmZvckVhY2goYSA9PiB7CiAgICBnZXRBY2NvdW50U2VydmVycyhhKS5mb3JFYWNoKHNpZCA9PiB7CiAgICAgIHRvdGFsVGFza3MucHVzaCh7CiAgICAgICAgYWNjb3VudDogYS5hY2NvdW50LAogICAgICAgIHB3ZDogZ2V0QWNjb3VudFBhc3N3b3JkKGEpLAogICAgICAgIHNlcnZlcmlkOiBTdHJpbmcoc2lkKSwKICAgICAgICBzZXJ2ZXJzOiBnZXRBY2NvdW50U2VydmVycyhhKSwKICAgICAgICBzdGF0dXM6ICdwZW5kaW5nJywKICAgICAgICBtc2c6ICfnrYnlvoXkuK0uLi4nCiAgICAgIH0pOwogICAgfSk7CiAgfSk7CiAgcmVzdWx0RGF0YSA9IHRvdGFsVGFza3M7CiAgY29uc3QgdG90YWxDb3VudCA9IHRvdGFsVGFza3MubGVuZ3RoOwoKICBzaG93UmVzdWx0Q2FyZCgpOwogIHVwZGF0ZVN0YXRzKCk7CiAgcmVuZGVyUmVzdWx0cygpOwoKICAvLyDmmL7npLrov5vluqbmnaEKICBjb25zdCBwcm9ncmVzc1dyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZ3Jlc3NXcmFwJyk7CiAgcHJvZ3Jlc3NXcmFwLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpOwoKICB0cnkgewogICAgY29uc3QgcmVzID0gYXdhaXQgYXBpRmV0Y2goJy9hcGkvYmF0Y2gtc2lnbmluJywgewogICAgICBtZXRob2Q6ICdQT1NUJywKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWNjb3VudHM6IHNlbmRBY2NvdW50cywgZGVsYXkgfSkKICAgIH0pOwoKICAgIGlmICghcmVzLm9rKSB7CiAgICAgIGNvbnN0IGVyckRhdGEgPSBhd2FpdCByZXMuanNvbigpLmNhdGNoKCgpID0+ICh7fSkpOwogICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyRGF0YS5lcnJvciB8fCBgSFRUUCAke3Jlcy5zdGF0dXN9YCk7CiAgICB9CgogICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7CiAgICBpZiAoZGF0YS5zdWNjZXNzICYmIEFycmF5LmlzQXJyYXkoZGF0YS5yZXN1bHRzKSkgewogICAgICAvLyDmm7TmlrDnu5PmnpzvvIjmjInpobrluo/ljLnphY3vvIkKICAgICAgZGF0YS5yZXN1bHRzLmZvckVhY2goKHIsIGkpID0+IHsKICAgICAgICBpZiAocmVzdWx0RGF0YVtpXSkgewogICAgICAgICAgcmVzdWx0RGF0YVtpXS5zdGF0dXMgPSByLnN1Y2Nlc3MgPyAnc3VjY2VzcycgOiAnZmFpbCc7CiAgICAgICAgICByZXN1bHREYXRhW2ldLm1zZyA9IHIubXNnOwogICAgICAgICAgcmVzdWx0RGF0YVtpXS5zZXJ2ZXJpZCA9IHIuc2VydmVyaWQ7CiAgICAgICAgfQogICAgICB9KTsKICAgICAgdXBkYXRlUHJvZ3Jlc3ModG90YWxDb3VudCwgdG90YWxDb3VudCk7CiAgICB9IGVsc2UgewogICAgICB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvciB8fCAn6L+U5Zue5pWw5o2u5byC5bi4Jyk7CiAgICB9CiAgfSBjYXRjaCAoZSkgewogICAgc2hvd1RvYXN0KGDnrb7liLDlh7rplJk6ICR7ZS5tZXNzYWdlfWAsICdlcnJvcicpOwogICAgLy8g5qCH6K6w5pyq5a6M5oiQ55qE5Li65aSx6LSlCiAgICByZXN1bHREYXRhLmZvckVhY2gociA9PiB7CiAgICAgIGlmIChyLnN0YXR1cyA9PT0gJ3BlbmRpbmcnKSB7CiAgICAgICAgci5zdGF0dXMgPSAnZmFpbCc7CiAgICAgICAgci5tc2cgPSAn5Lu75Yqh5Lit5patOiAnICsgZS5tZXNzYWdlOwogICAgICB9CiAgICB9KTsKICB9IGZpbmFsbHkgewogICAgaXNSdW5uaW5nID0gZmFsc2U7CiAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgIGJ0bi50ZXh0Q29udGVudCA9ICflvIDlp4vmibnph4/nrb7liLAnOwogICAgdXBkYXRlU3RhdHMoKTsKICAgIHJlbmRlclJlc3VsdHMoKTsKCiAgICAvLyAz56eS5ZCO6ZqQ6JeP6L+b5bqm5p2hCiAgICBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgcHJvZ3Jlc3NXcmFwLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpOwogICAgfSwgMzAwMCk7CgogICAgY29uc3Qgc3VjY2Vzc0NvdW50ID0gcmVzdWx0RGF0YS5maWx0ZXIociA9PiByLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnKS5sZW5ndGg7CiAgICBjb25zdCBmYWlsQ291bnQgPSByZXN1bHREYXRhLmZpbHRlcihyID0+IHIuc3RhdHVzID09PSAnZmFpbCcpLmxlbmd0aDsKICAgIHNob3dUb2FzdChg562+5Yiw5a6M5oiQ77ya5oiQ5YqfICR7c3VjY2Vzc0NvdW50fSDkuKrvvIzlpLHotKUgJHtmYWlsQ291bnR9IOS4qmAsIHN1Y2Nlc3NDb3VudCA+IDAgPyAnc3VjY2VzcycgOiAnaW5mbycpOwogIH0KfQoKZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3MoY3VycmVudCwgdG90YWwpIHsKICBjb25zdCBwZXJjZW50ID0gTWF0aC5yb3VuZCgoY3VycmVudCAvIHRvdGFsKSAqIDEwMCk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2dyZXNzRmlsbCcpLnN0eWxlLndpZHRoID0gcGVyY2VudCArICclJzsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZ3Jlc3NQZXJjZW50JykudGV4dENvbnRlbnQgPSBwZXJjZW50ICsgJyUnOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9ncmVzc1RleHQnKS50ZXh0Q29udGVudCA9IGDmraPlnKjnrb7liLAgJHtjdXJyZW50fS8ke3RvdGFsfWA7Cn0KCi8vID09PT09PT09PT0g57uT5p6c5bGV56S6ID09PT09PT09PT0KZnVuY3Rpb24gc2hvd1Jlc3VsdENhcmQoKSB7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jlc3VsdENhcmQnKS5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsKfQoKZnVuY3Rpb24gdXBkYXRlU3RhdHMoKSB7CiAgY29uc3QgdG90YWwgPSByZXN1bHREYXRhLmxlbmd0aDsKICBjb25zdCBzdWNjZXNzID0gcmVzdWx0RGF0YS5maWx0ZXIociA9PiByLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnKS5sZW5ndGg7CiAgY29uc3QgZmFpbCA9IHJlc3VsdERhdGEuZmlsdGVyKHIgPT4gci5zdGF0dXMgPT09ICdmYWlsJykubGVuZ3RoOwogIGNvbnN0IHBlbmRpbmcgPSByZXN1bHREYXRhLmZpbHRlcihyID0+IHIuc3RhdHVzID09PSAncGVuZGluZycgfHwgci5zdGF0dXMgPT09ICdydW5uaW5nJykubGVuZ3RoOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0VG90YWwnKS50ZXh0Q29udGVudCA9IHRvdGFsOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0U3VjY2VzcycpLnRleHRDb250ZW50ID0gc3VjY2VzczsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdEZhaWwnKS50ZXh0Q29udGVudCA9IGZhaWw7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXRQZW5kaW5nJykudGV4dENvbnRlbnQgPSBwZW5kaW5nOwp9CgpmdW5jdGlvbiByZW5kZXJSZXN1bHRzKCkgewogIGNvbnN0IHRib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jlc3VsdEJvZHknKTsKICB0Ym9keS5pbm5lckhUTUwgPSAnJzsKICByZXN1bHREYXRhLmZvckVhY2goKHIsIGkpID0+IHsKICAgIGNvbnN0IHRyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndHInKTsKICAgIGNvbnN0IHN0YXR1c0NsYXNzID0gci5zdGF0dXMgPT09ICdzdWNjZXNzJyA/ICdzdWNjZXNzJyA6IChyLnN0YXR1cyA9PT0gJ2ZhaWwnID8gJ2ZhaWwnIDogJ3BlbmRpbmcnKTsKICAgIGNvbnN0IHN0YXR1c1RleHQgPSByLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnID8gJ+aIkOWKnycgOiAoci5zdGF0dXMgPT09ICdmYWlsJyA/ICflpLHotKUnIDogJ+etieW+hScpOwogICAgdHIuaW5uZXJIVE1MID0gYAogICAgICA8dGQ+JHtpICsgMX08L3RkPgogICAgICA8dGQ+JHtlc2NhcGVIdG1sKHIuYWNjb3VudCl9PC90ZD4KICAgICAgPHRkPiR7U0VSVkVSX05BTUVTW3BhcnNlSW50KHIuc2VydmVyaWQpIC0gMV0gfHwgci5zZXJ2ZXJpZCArICfljLonfTwvdGQ+CiAgICAgIDx0ZD48c3BhbiBjbGFzcz0ic3RhdHVzLXRhZyAke3N0YXR1c0NsYXNzfSI+JHtzdGF0dXNUZXh0fTwvc3Bhbj48L3RkPgogICAgICA8dGQgY2xhc3M9Im1zZy10ZXh0Ij4ke2VzY2FwZUh0bWwoci5tc2cgfHwgJycpfTwvdGQ+CiAgICBgOwogICAgdGJvZHkuYXBwZW5kQ2hpbGQodHIpOwogIH0pOwp9CgovLyA9PT09PT09PT09IOW3peWFt+WHveaVsCA9PT09PT09PT09CmZ1bmN0aW9uIGVzY2FwZUh0bWwoc3RyKSB7CiAgY29uc3QgZGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgZGl2LnRleHRDb250ZW50ID0gc3RyIHx8ICcnOwogIHJldHVybiBkaXYuaW5uZXJIVE1MOwp9CgpmdW5jdGlvbiBzaG93VG9hc3QobXNnLCB0eXBlID0gJ2luZm8nKSB7CiAgY29uc3QgY29udGFpbmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvYXN0Q29udGFpbmVyJyk7CiAgY29uc3QgdG9hc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICB0b2FzdC5jbGFzc05hbWUgPSBgdG9hc3QgJHt0eXBlfWA7CiAgdG9hc3QudGV4dENvbnRlbnQgPSBtc2c7CiAgY29udGFpbmVyLmFwcGVuZENoaWxkKHRvYXN0KTsKICBzZXRUaW1lb3V0KCgpID0+IHsKICAgIHRvYXN0LnN0eWxlLm9wYWNpdHkgPSAnMCc7CiAgICB0b2FzdC5zdHlsZS50cmFuc2Zvcm0gPSAndHJhbnNsYXRlWCgzMHB4KSc7CiAgICB0b2FzdC5zdHlsZS50cmFuc2l0aW9uID0gJ2FsbCAwLjNzIGVhc2UnOwogICAgc2V0VGltZW91dCgoKSA9PiB0b2FzdC5yZW1vdmUoKSwgMzAwKTsKICB9LCAzMDAwKTsKfQo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==`;
function getInlineIndexHtml() {
    const binary = atob(INLINE_INDEX_HTML_B64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return Buffer.from(bytes).toString('utf-8');
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
            // 如果请求的是 index.html 或根路径，返回内联页面
            if (urlPath === '/index.html' || urlPath === '/') {
                try {
                    const inlineHtml = getInlineIndexHtml();
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(inlineHtml);
                    return;
                } catch (e) {
                    // 内联页面加载失败，继续返回 404
                }
            }
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
