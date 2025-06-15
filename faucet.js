import { HttpsProxyAgent } from 'https-proxy-agent';
import axios from 'axios';
import fs from 'fs';
import { ethers } from 'ethers';
import chalk from 'chalk';
import pLimit from 'p-limit';

// ========== CONFIG ==========
const THREADS = 2; // Ограничение для входов и фаусет-запросов
const LOGIN_LIMIT = pLimit(THREADS); // Ограничение для операций входа
const FAUCET_LIMIT = pLimit(THREADS); // Ограничение для фаусет-запросов
const INVITE_CODE = "PfgObQse66AfgWpd";
const MAX_RETRIES = 5; // Для обработки ошибок 429
const SIGN_MESSAGE = "pharos";
const PRIV_FILE = "priv.txt";
const PROXIES_FILE = "proxies.txt";
const PHAROS_SUCCESS_FILE = "./logs/success_log/pharos_success.txt";
const PHAROS_FAILED_FILE = "./logs/failed_log/pharos_failed.txt";
const FAUCET_PHAROS_URL = "https://api.pharosnetwork.xyz/faucet/daily"; // Для POST
const FAUCET_STATUS_URL = "https://api.pharosnetwork.xyz/faucet/status"; // Для GET
const LOGIN_URL = "https://api.pharosnetwork.xyz/user/login";
const GET_IP_URL = "https://api64.ipify.org?format=json";
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 часа

// Список случайных User-Agent
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:89.0) Gecko/20100101 Firefox/89.0",
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function nowStr() {
    const d = new Date();
    const hours = d.getHours() % 12 || 12;
    const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
    return `[${hours.toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')} ${ampm} ${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()}]`;
}

function shortAddr(addr) {
    return addr.slice(0, 4) + "..." + addr.slice(-6);
}

function loadLines(path, { allowNullIfEmpty = false } = {}) {
    if (!fs.existsSync(path)) {
        return allowNullIfEmpty ? [null] : [];
    }
    const lines = fs.readFileSync(path, "utf8").split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0 && allowNullIfEmpty) return [null];
    return lines;
}

function getAxiosWithProxy(proxy) {
    if (!proxy) return axios.create({ timeout: 20000 });
    const agent = new HttpsProxyAgent(proxy);
    return axios.create({
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 20000,
    });
}

async function getCurrentIp(proxy) {
    try {
        const client = getAxiosWithProxy(proxy);
        const { data } = await client.get(GET_IP_URL);
        return data.ip || "???";
    } catch (e) {
        return "???";
    }
}

async function signMessage(privkey, message) {
    const wallet = new ethers.Wallet(privkey);
    const sig = await wallet.signMessage(message);
    return { address: wallet.address, signature: sig };
}

function getHeaders(jwt, userAgent) {
    return {
        "Accept": "application/json, text/plain, */*",
        "Authorization": jwt ? `Bearer ${jwt}` : null,
        "Origin": "https://testnet.pharosnetwork.xyz",
        "Referer": "https://testnet.pharosnetwork.xyz/",
        "User-Agent": userAgent || getRandomUserAgent(),
    };
}

function formatCooldownTime(nextClaimTime) {
    const diffMs = nextClaimTime - Date.now();
    const hours = Math.floor(diffMs / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    return `${hours} ч ${minutes} мин`;
}

async function getFaucetStatus(address, jwt, proxy) {
    const client = getAxiosWithProxy(proxy);
    try {
        const res = await client.get(FAUCET_STATUS_URL, {
            params: { address },
            headers: getHeaders(jwt, getRandomUserAgent()),
        });
        return res.data; // { code, data: { avaliable_timestamp, is_able_to_faucet }, msg }
    } catch (e) {
        if (e.response?.status === 429) {
            const nextClaimTime = Date.now() + COOLDOWN_MS;
            const prefix = chalk.cyan(`${nowStr()} [${shortAddr(address)}]`);
            console.log(
                `${prefix} ${chalk.yellow(`Фаусет на кулдауне (429). Следующая попытка через ${formatCooldownTime(nextClaimTime)}`)}`
            );
            return { msg: "faucet did not cooldown", data: { avaliable_timestamp: nextClaimTime / 1000 } };
        }
        console.log(chalk.red(`Ошибка проверки статуса фаусета: ${e.message}`));
        return null;
    }
}

async function loginPharos(idx, privkey, proxy) {
    const client = getAxiosWithProxy(proxy);
    let retry = 0;
    const { address, signature } = await signMessage(privkey, SIGN_MESSAGE);
    const prefix = chalk.cyan(`${nowStr()} [${idx}] [${chalk.yellow(shortAddr(address))}]`);

    while (retry < MAX_RETRIES) {
        const ip = await getCurrentIp(proxy);
        const userAgent = getRandomUserAgent();
        console.log(`${prefix} IP прокси: ${chalk.green(ip)} [Повтор ${retry + 1}/${MAX_RETRIES}]`);

        try {
            const params = { address, signature, invite_code: INVITE_CODE };
            const { data } = await client.post(LOGIN_URL, null, { params, headers: getHeaders(null, userAgent) });
            const jwt = data?.data?.jwt;
            if (!jwt) throw new Error("Нет возвращенного JWT");
            console.log(`${prefix} ${chalk.green("Вход выполнен успешно.")}`);
            return jwt;
        } catch (e) {
            console.log(`${prefix} ${chalk.red("Ошибка входа: " + e.message)}`);
            if (e.response?.status === 429) {
                const delay = 5000 * Math.pow(2, retry); // Экспоненциальная задержка: 5, 10, 20, 40 сек
                console.log(`${prefix} ${chalk.yellow(`Превышен лимит запросов (429). Ожидание ${delay / 1000} секунд...`)}`);
                await new Promise(r => setTimeout(r, delay));
            }
            retry++;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`${prefix} ${chalk.red("Не удалось выполнить вход после максимального количества попыток.")}`);
    return null;
}

async function faucetPharos(idx, privkey, proxy, jwt) {
    const client = getAxiosWithProxy(proxy);
    const { address } = await signMessage(privkey, SIGN_MESSAGE);
    const prefix = chalk.cyan(`${nowStr()} [${idx}] [${chalk.yellow(shortAddr(address))}]`);

    // Проверка статуса фаусета через GET
    const status = await getFaucetStatus(address, jwt, proxy);
    if (status?.data?.is_able_to_faucet === false || status?.data?.avaliable_timestamp) {
        const nextClaimTime = status.data.avaliable_timestamp ? new Date(status.data.avaliable_timestamp * 1000) : new Date(Date.now() + COOLDOWN_MS);
        console.log(
            `${prefix} ${chalk.yellow(`Фаусет на кулдауне. Следующая попытка через ${formatCooldownTime(nextClaimTime)}`)}`
        );
        fs.appendFileSync(PHAROS_SUCCESS_FILE, `${address}:${privkey}\n`);
        return { success: false, cooldown: true };
    }

    // Выполнение POST-запроса к фаусету
    try {
        const params = { address };
        const { data } = await client.post(
            FAUCET_PHAROS_URL,
            {},
            { params, headers: getHeaders(jwt, getRandomUserAgent()) }
        );
        const msg = data?.msg || "";

        if (msg === "ok") {
            console.log(`${prefix} ${chalk.green("Запрос фаусета Pharos выполнен успешно!")}`);
            fs.appendFileSync(PHAROS_SUCCESS_FILE, `${address}:${privkey}\n`);
            return { success: true, cooldown: false };
        } else if (msg === "faucet did not cooldown") {
            const nextClaimTime = new Date(Date.now() + COOLDOWN_MS);
            console.log(
                `${prefix} ${chalk.yellow(`Фаусет уже использован. Следующая попытка через ${formatCooldownTime(nextClaimTime)}`)}`
            );
            fs.appendFileSync(PHAROS_SUCCESS_FILE, `${address}:${privkey}\n`);
            return { success: false, cooldown: true };
        } else if (msg.includes("user has not bound X account")) {
            console.log(`${prefix} ${chalk.yellow("Необходимо привязать аккаунт X к фаусету")}`);
            fs.appendFileSync(PHAROS_FAILED_FILE, `${address}:${privkey}\n`);
            return { success: false, cooldown: false };
        } else {
            console.log(`${prefix} ${chalk.red("Ошибка запроса фаусета: " + JSON.stringify(data))}`);
            fs.appendFileSync(PHAROS_FAILED_FILE, `${address}:${privkey}\n`);
            return { success: false, cooldown: false };
        }
    } catch (e) {
        if (e.response?.status === 429) {
            const nextClaimTime = new Date(Date.now() + COOLDOWN_MS);
            console.log(
                `${prefix} ${chalk.yellow(`Фаусет на кулдауне (429). Следующая попытка через ${formatCooldownTime(nextClaimTime)}`)}`
            );
            fs.appendFileSync(PHAROS_SUCCESS_FILE, `${address}:${privkey}\n`);
            return { success: false, cooldown: true };
        }
        console.log(`${prefix} ${chalk.red("Ошибка запроса фаусета: " + e.message)}`);
        fs.appendFileSync(PHAROS_FAILED_FILE, `${address}:${privkey}\n`);
        return { success: false, cooldown: false };
    }
}

async function runPharosFaucet() {
    const privs = loadLines(PRIV_FILE);
    const proxies = loadLines(PROXIES_FILE, { allowNullIfEmpty: true });
    const results = [];

    const tasks = privs.map((priv, idx) => {
        const proxy = proxies[idx % proxies.length];
        return FAUCET_LIMIT(async () => {
            const delay = 5000 + Math.random() * 5000; // 5–10 секунд
            await new Promise(r => setTimeout(r, delay));
            console.log(chalk.blue(`${nowStr()} [${idx + 1}] Задержка перед фаусетом: ${(delay / 1000).toFixed(2)} сек`));

            // Ограниченный вход
            const jwt = await LOGIN_LIMIT(() => loginPharos(idx + 1, priv, proxy));
            if (!jwt) {
                const address = new ethers.Wallet(priv).address;
                results.push({ address, success: false, cooldown: false });
                return;
            }

            // Ограниченный фаусет-запрос
            const result = await faucetPharos(idx + 1, priv, proxy, jwt);
            results.push({ address: new ethers.Wallet(priv).address, ...result });
        });
    });

    await Promise.all(tasks);
    console.log(chalk.green(`${nowStr()} Выполнение фаусета Pharos завершено.`));
    return results;
}

async function tryFaucetForWallet(idx, privkey, proxy) {
    const jwt = await loginPharos(idx, privkey, proxy);
    if (!jwt) return { success: false, cooldown: false };
    return await faucetPharos(idx, privkey, proxy, jwt);
}

export { runPharosFaucet, tryFaucetForWallet };