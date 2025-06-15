import { isAddress } from 'ethers';
import HttpsProxyAgent from 'https-proxy-agent';
import fs from 'fs';
import { ethers } from 'ethers';
import { JsonRpcProvider } from "ethers";
import pLimit from 'p-limit';
import promptSync from 'prompt-sync';
import chalk from 'chalk';
import { runPharosFaucet, tryFaucetForWallet } from './faucet.js';
import {
    PHAROS_RPC, CHAIN_ID, WPHRS_ADDRESS, USDC_ADDRESS, SWAP_ROUTER_ADDRESS,
    ERC20_ABI, SWAP_ROUTER_ABI, USDC_POOL_ADDRESS, LP_ROUTER_ADDRESS, LP_ROUTER_ABI, POOL_ABI, USDT_ADDRESS
} from "./contract_web3.js";
import { translations } from './translations.js';

// ========== CONFIG ==========
const INVITE_CODE = "PfgObQse66AfgWpd";
const SIGN_MESSAGE = "pharos";
const MIN_SLEEP = 5;
const MAX_SLEEP = 10;
const PRIV_FILE = "priv.txt";
const PROXIES_FILE = "proxies.txt";
const MAX_RETRIES = 3;
const MAX_ATTEMPTS = 3;
const MIN_PHRS_FOR_WRAP = ethers.parseEther("0.001");
const prompt = promptSync({ sigint: true });

const LOGIN_URL = "https://api.pharosnetwork.xyz/user/login";
const FAUCET_PHAROS_URL = "https://api.pharosnetwork.xyz/faucet/daily";
const CHECKIN_URL = "https://api.pharosnetwork.xyz/sign/in";
const GET_IP_URL = "https://api64.ipify.org?format=json";
const ZENITH_FAUCET_URL = "https://testnet-router.zenithswap.xyz/api/v1/faucet";
const ZENITH_TOKEN_ADDRESS = "0xAD902CF99C2dE2f1Ba5ec4d642fd7E49cae9EE37";
const TASK_TIMEOUT = 20 * 1000;
const SAFE_TIMEOUT = 10 * 1000;
const TX_TIMEOUT = 60 * 1000;
const MIN_DELAY = 5000;
const MAX_DELAY = 20000;

process.on('unhandledRejection', (reason, promise) => {
    console.log('\n', `${nowStr('EN')} [GLOBAL] ${translate('EN', 'globalUnhandledRejection', { reason })}`);
});
process.on('uncaughtException', (err) => {
    console.log('\n', `${nowStr('EN')} [GLOBAL] ${translate('EN', 'globalUncaughtException', { err })}`);
});

// Определение директорий для логов
const successLogDir = './logs/success_log';
const failedLogDir = './logs/failed_log';
if (!fs.existsSync(successLogDir)) fs.mkdirSync(successLogDir, { recursive: true });
if (!fs.existsSync(failedLogDir)) fs.mkdirSync(failedLogDir, { recursive: true });

const balanceLog = `${failedLogDir}/balance.log`;
const successLog = `${successLogDir}/success.log`;
const failedTxLog = `${failedLogDir}/failed_tx.log`;
if (!fs.existsSync(balanceLog)) fs.writeFileSync(balanceLog, '');
if (!fs.existsSync(successLog)) fs.writeFileSync(successLog, '');
if (!fs.existsSync(failedTxLog)) fs.writeFileSync(failedTxLog, '');

function translate(lang, key, params = {}) {
    let text = translations[lang][key];
    if (!text) {
        console.warn(`Missing translation for key "${key}" in language "${lang}", falling back to EN`);
        text = translations['EN'][key] || `Missing translation: ${key}`;
    }
    for (const [key, value] of Object.entries(params)) {
        text = text.replace(`{${key}}`, value);
    }
    return text;
}

function loadLines(path, { allowNullIfEmpty = false } = {}) {
    if (!fs.existsSync(path)) return allowNullIfEmpty ? [null] : [];
    const lines = fs.readFileSync(path, "utf8").split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length === 0 && allowNullIfEmpty ? [null] : lines;
}

function shortAddr(addr) {
    return addr.slice(0, 4) + "..." + addr.slice(-6);
}

function nowStr(lang = 'EN') {
    const d = new Date();
    const hours = d.getHours() % 12 || 12;
    const ampm = d.getHours() >= 12 ? (lang === 'EN' ? 'PM' : 'ВМ') : (lang === 'EN' ? 'AM' : 'УТ');
    return `[${hours.toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')} ${ampm} +05 ${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()}]`;
}

function getExactInputSingleData({ tokenIn, tokenOut, fee, recipient, amountIn }) {
    return new ethers.Interface([
        'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
    ]).encodeFunctionData("exactInputSingle", [{
        tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0
    }]);
}

function addRandomDelay(lang) {
    const delay = MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
    console.log(`${nowStr(lang)} ${translate(lang, 'delayMsg', { delay: (delay / 1000).toFixed(1) })}`);
    return safeSleep(delay);
}

function safeSleep(ms) {
    const fallbackDelay = 5000;
    return new Promise(resolve => setTimeout(resolve, isNaN(ms) || ms <= 0 ? fallbackDelay : ms));
}

async function getProviderWithProxy(proxy, maxRetries = 3, lang) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            if (proxy) {
                const agent = new HttpsProxyAgent(proxy);
                const provider = new JsonRpcProvider(PHAROS_RPC, { chainId: CHAIN_ID, name: "Pharos Testnet" }, { fetchOptions: { agent }, timeout: 5000 });
                provider.getEnsAddress = async (name) => isAddress(name) ? name : null;
                provider.resolveName = async (name) => isAddress(name) ? name : null;
                provider.getResolver = async () => null;
                await provider.getBlockNumber();
                return provider;
            }
            const provider = new JsonRpcProvider(PHAROS_RPC, { chainId: CHAIN_ID, name: "Pharos Testnet" }, { timeout: 5000 });
            provider.getEnsAddress = async (name) => isAddress(name) ? name : null;
            provider.resolveName = async (name) => isAddress(name) ? name : null;
            provider.getResolver = async () => null;
            await provider.getBlockNumber();
            return provider;
        } catch (e) {
            retries++;
            if (retries === maxRetries) {
                throw new Error(translate(lang, 'providerCreationFailed', { retries: maxRetries, error: e.message }));
            }
            console.log(`${nowStr(lang)} [RETRY] ${translate(lang, 'providerRetry', { retry: retries, maxRetries })}`);
            const delay = 1000 * retries;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function checkBalance(wallet, provider, prefix, lang) {
    const phrsBalance = await provider.getBalance(wallet.address);
    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'balancePhrs', { balance: ethers.formatEther(phrsBalance) })}`);

    const minGasBalance = ethers.parseUnits("0.01", 18);
    if (phrsBalance < minGasBalance) {
        console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'lowGasBalance', { balance: ethers.formatEther(phrsBalance) })}`);
        fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'lowGasBalanceLog', { address: wallet.address })}\n`);
        return false;
    }

    const warnGasBalance = ethers.parseUnits("0.05", 18);
    if (phrsBalance < warnGasBalance) {
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'warnGasBalance', { balance: ethers.formatEther(phrsBalance) })}`);
        const wphrsContract = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, wallet);
        const wphrsBalance = await wphrsContract.balanceOf(wallet.address);
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'balanceWphrs', { balance: ethers.formatEther(wphrsBalance) })}`);

        const minWphrsForExchange = ethers.parseUnits("0.001", 18);
        if (wphrsBalance < minWphrsForExchange) {
            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'insufficientWphrs', { balance: ethers.formatEther(wphrsBalance) })}`);
            fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'noWphrsExchange', { address: wallet.address })}\n`);
            return false;
        }

        const amountToUnwrap = ethers.parseUnits("0.01", 18);
        if (amountToUnwrap > wphrsBalance) {
            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'insufficientWphrsUnwrap', { balance: ethers.formatEther(wphrsBalance), amount: ethers.formatEther(amountToUnwrap) })}`);
            fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'wphrsUnwrapError', { address: wallet.address })}\n`);
            return false;
        }

        let gasLimit = 50000n;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const gasPrice = await provider.getGasPrice();
                const estimatedGas = gasLimit * gasPrice;
                if (phrsBalance < estimatedGas) {
                    console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'insufficientGas', { balance: ethers.formatEther(phrsBalance), gas: ethers.formatEther(estimatedGas) })}`);
                    break;
                }

                const nonce = await provider.getTransactionCount(wallet.address, "pending");
                const tx = await wphrsContract.withdraw(amountToUnwrap, { gasLimit, gasPrice, nonce });
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapTxSent', { hash: tx.hash })}`);
                const receipt = await waitWithTimeout(tx, TX_TIMEOUT, lang);
                if (receipt.status !== 1) {
                    throw new Error(translate(lang, 'transactionFailed', { hash: tx.hash }));
                }
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapSuccess', { hash: tx.hash })}`);
                return true;
            } catch (error) {
                if (attempt < 3) {
                    console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapRetry', { delay: 20 + Math.floor(Math.random() * 40), error: error.message })}`);
                    fs.appendFileSync(failedTxLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapError', { error: error.message })}\n`);
                    const delay = 20000 + Math.floor(Math.random() * 40000);
                    await safeSleep(delay);
                    gasLimit = (gasLimit * 120n) / 100n;
                    continue;
                }
                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapFailed', { error: error.message })}`);
                fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapFailedLog', { address: wallet.address })}\n`);
                return false;
            }
        }
    }
    return true;
}

async function approveIfNeeded(token, wallet, provider, owner, spender, amount, prefix, symbol, lang) {
    if (!await checkBalance(wallet, provider, prefix, lang)) return false;
    if (symbol === "PHRS") return true;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const allowance = await token.allowance(owner, spender);
            if (allowance < amount) {
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'approvingToken', { symbol, spender: shortAddr(spender), amount: ethers.formatEther(amount) })}`);
                const nonce = await provider.getTransactionCount(owner, "pending");
                const tx = await token.approve(spender, amount, { gasLimit: 100000n, gasPrice: ethers.parseUnits("10", "gwei"), nonce });
                const receipt = await tx.wait();
                if (receipt.status !== 1) {
                    throw new Error(translate(lang, 'approvalFailed', { hash: tx.hash }));
                }
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'tokenApproved', { symbol, hash: tx.hash })}`);
                return true;
            }
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'tokenAlreadyApproved', { symbol })}`);
            return true;
        } catch (error) {
            if (error.code === 'TIMEOUT' || error.message?.includes("timeout")) {
                const delay = 2000 * Math.pow(2, attempt - 1);
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryAttempt', { delay: (delay / 1000).toFixed(1), message: error.message })}`);
                await new Promise(r => setTimeout(r, delay));
            } else if (error.code === -32000 || error.message?.includes("executed")) {
                const delay = 2000 + Math.random() * 3000;
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryAttempt', { delay: (delay / 1000).toFixed(1), message: error.message })}`);
                const freshNonce = await provider.getTransactionCount(owner, "pending");
                const increasedGasLimit = (100000n * BigInt(150)) / 100n;
                const txRetry = await token.approve(spender, amount, { nonce: freshNonce, gasLimit: increasedGasLimit, gasPrice: ethers.parseUnits("10", "gwei") });
                const receipt = await txRetry.wait();
                if (receipt.status !== 1) {
                    throw new Error(translate(lang, 'approvalRetryFailed', { hash: txRetry.hash }));
                }
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'tokenRetryApproved', { symbol, hash: txRetry.hash })}`);
                return true;
            } else if (error.code === -32003 || error.message?.includes("Request too fast")) {
                if (attempt === MAX_RETRIES) {
                    console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'maxRetriesExceeded', { retries: MAX_RETRIES })}`);
                    fs.appendFileSync(failedTxLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'approvalError', { symbol, message: error.message })}\n`);
                    return false;
                }
                const delay = 5000 * Math.pow(2, attempt - 1);
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryAttempt', { delay: (delay / 1000).toFixed(1), message: error.message })}`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'generalError', { message: error.message })}`);
                fs.appendFileSync(failedTxLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'approvalError', { symbol, message: error.message })}\n`);
                return false;
            }
        }
    }
    return false;
}

async function swap(wallet, provider, fromToken, toToken, amountInWei, prefix, wDec, uDec, lang) {
    if (!await checkBalance(wallet, provider, prefix, lang)) {
        return false;
    }

    if (fromToken === toToken) {
        console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'sameTokenError')}`);
        return false;
    }

    let balance = 0n;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const tokenContract = fromToken === "0x0" ? null : new ethers.Contract(fromToken, ERC20_ABI, wallet);
            const tokenName = fromToken === "0x0" ? "PHRS" : (fromToken === WPHRS_ADDRESS ? "WPHRS" : (fromToken === USDC_ADDRESS ? "USDC" : "USDT"));
            const decimals = fromToken === "0x0" ? 18 : (fromToken === WPHRS_ADDRESS ? wDec : uDec);

            balance = fromToken === "0x0" ? await provider.getBalance(wallet.address) : await tokenContract.balanceOf(wallet.address);
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'balanceCheck', { token: tokenName, balance: ethers.formatUnits(balance, decimals) })}`);

            if (balance < amountInWei) {
                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'insufficientBalance', { token: tokenName, balance: ethers.formatUnits(balance, decimals), amount: ethers.formatUnits(amountInWei, decimals) })}`);
                fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'insufficientBalanceLog', { token: tokenName, balance: ethers.formatUnits(balance, decimals) })}\n`);
                return false;
            }

            if (!isAddress(SWAP_ROUTER_ADDRESS)) {
                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'invalidAddress', { name: "SWAP_ROUTER", addr: SWAP_ROUTER_ADDRESS })}`);
                return false;
            }

            const router = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
            const deadline = Math.floor(Date.now() / 1000) + 600;
            const exactInputData = getExactInputSingleData({
                tokenIn: fromToken === "0x0" ? WPHRS_ADDRESS : fromToken,
                tokenOut: toToken,
                fee: 500,
                recipient: wallet.address,
                amountIn: amountInWei
            });

            let gasLimit = 300000n;
            try {
                const est = await router.estimateGas.multicall(deadline, [exactInputData], { value: fromToken === "0x0" ? amountInWei : 0n });
                gasLimit = (est * 120n) / 100n;
            } catch (error) {
                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'gasEstimateError')}`);
            }

            if (fromToken !== "0x0") {
                if (!await approveIfNeeded(tokenContract, wallet, provider, wallet.address, SWAP_ROUTER_ADDRESS, amountInWei, prefix, tokenName, lang)) {
                    return false;
                }
            }

            const nonce = await provider.getTransactionCount(wallet.address, "pending");
            const tx = await router.multicall(deadline, [exactInputData], {
                gasLimit,
                gasPrice: ethers.parseUnits("10", "gwei"),
                value: fromToken === "0x0" ? amountInWei : 0n,
                nonce
            });
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'transactionSent', { hash: tx.hash })}`);
            const receipt = await waitWithTimeout(tx, TX_TIMEOUT, lang);
            if (receipt.status !== 1) {
                throw new Error(translate(lang, 'transactionFailed', { hash: tx.hash }));
            }
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'transactionSuccess', { hash: tx.hash })}`);
            fs.appendFileSync(successLog, `${nowStr(lang)} ${translate(lang, 'successfulWalletSwap', { address: wallet.address, hash: tx.hash })}\n`);
            return true;

        } catch (error) {
            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'swapError', { attempt: attempt, maxAttempts: MAX_ATTEMPTS, message: error.message })}`);
            fs.appendFileSync(failedTxLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'swapErrorLog', { message: error.message })}\n`);
            if (attempt < MAX_ATTEMPTS) {
                const delay = 20000 + Math.random() * 30000;
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryAttempt', { delay: (delay / 1000).toFixed(1), message: error.message })}`);
                await safeSleep(delay);
            }
        }
    }
    return false;
}

async function addLiquidity(wallet, provider, amountWPHRS, amountUSDC, prefix, wDec, uDec, lang, options = {}) {
    if (!await checkBalance(wallet, provider, prefix, lang)) {
        return false;
    }

    try {
        const lpRouter = new ethers.Contract(LP_ROUTER_ADDRESS, LP_ROUTER_ABI, wallet);
        const pool = new ethers.Contract(USDC_POOL_ADDRESS, POOL_ABI, provider);

        const token0 = await pool.token0();
        const token1 = await pool.token1();
        const fee = Number(await pool.fee());

        if (WPHRS_ADDRESS.toLowerCase() > USDC_ADDRESS.toLowerCase()) {
            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'tokenOrderError')}`);
            return false;
        }

        const MIN_WPHRS_FOR_LIQ = ethers.parseUnits("0.001", wDec);
        const MIN_USDC_FOR_LIQ = ethers.parseUnits("0.01", uDec);
        const wphrsCt = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, provider);
        const usdcCt = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
        let wphrsBalance = await wphrsCt.balanceOf(wallet.address);
        let usdcBalance = await usdcCt.balanceOf(wallet.address);
        const phrsBalance = await provider.getBalance(wallet.address);

        const sufficientForLiquidity = wphrsBalance >= MIN_WPHRS_FOR_LIQ && usdcBalance >= MIN_USDC_FOR_LIQ;
        if (!sufficientForLiquidity && !options.noSwap) {
            if (usdcBalance > ethers.parseUnits("1", uDec) && wphrsBalance < MIN_WPHRS_FOR_LIQ) {
                const availableForSwap = usdcBalance - MIN_USDC_FOR_LIQ;
                const maxSwapAmount = availableForSwap > ethers.parseUnits("0.5", uDec) ? ethers.parseUnits("0.5", uDec) : availableForSwap;
                const amountToSwap = maxSwapAmount > 0n ? maxSwapAmount : ethers.parseUnits("0.1", uDec);
                if (amountToSwap > 0n) {
                    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'swappingUsdcToWphrs', { amount: ethers.formatUnits(amountToSwap, uDec) })}`);
                    if (!await swap(wallet, provider, USDC_ADDRESS, WPHRS_ADDRESS, amountToSwap, prefix, uDec, wDec, lang)) {
                        return false;
                    }
                    wphrsBalance = await wphrsCt.balanceOf(wallet.address);
                    await safeSleep(5000);
                }
            }

            if (wphrsBalance < MIN_WPHRS_FOR_LIQ || usdcBalance < MIN_USDC_FOR_LIQ) {
                if (phrsBalance > 0n) {
                    const amountToSwapWPHRS = wphrsBalance < MIN_WPHRS_FOR_LIQ ? ethers.parseUnits("0.005", 18) : 0n;
                    const amountToSwapUSDC = usdcBalance < MIN_USDC_FOR_LIQ ? ethers.parseUnits("0.55", 18) : 0n;
                    const totalSwapAmount = amountToSwapWPHRS + amountToSwapUSDC;
                    if (phrsBalance >= totalSwapAmount && totalSwapAmount > 0n) {
                        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'swappingPhrs', { wphrs: ethers.formatEther(amountToSwapWPHRS), usdc: ethers.formatEther(amountToSwapUSDC) })}`);
                        if (amountToSwapWPHRS > 0n && !await swap(wallet, provider, "0x0", WPHRS_ADDRESS, amountToSwapWPHRS, prefix, wDec, uDec, lang)) {
                            return false;
                        }
                        if (amountToSwapUSDC > 0n && !await swap(wallet, provider, "0x0", USDC_ADDRESS, amountToSwapUSDC, prefix, wDec, uDec, lang)) {
                            return false;
                        }
                        wphrsBalance = await wphrsCt.balanceOf(wallet.address);
                        usdcBalance = await usdcCt.balanceOf(wallet.address);
                        await safeSleep(5000);
                    } else {
                        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'insufficientPhrs', { balance: ethers.formatEther(phrsBalance) })}`);
                        return false;
                    }
                } else {
                    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'noPhrsForSwap')}`);
                    return false;
                }
            }
        }

        if (wphrsBalance < MIN_WPHRS_FOR_LIQ || usdcBalance < MIN_USDC_FOR_LIQ) {
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'insufficientLiquidity', { wphrs: ethers.formatUnits(wphrsBalance, wDec), usdc: ethers.formatUnits(usdcBalance, uDec) })}`);
            return false;
        }

        let [amount0, amount1, symbol0, symbol1] = [amountWPHRS, amountUSDC, "wPHRS", "USDC"];
        if (token0.toLowerCase() !== WPHRS_ADDRESS.toLowerCase()) {
            [amount0, amount1] = [amountUSDC, amountWPHRS];
            [symbol0, symbol1] = ["USDC", "wPHRS"];
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'amountsReordered', { amount0: ethers.formatUnits(amount0, symbol0 === "wPHRS" ? wDec : uDec), amount1: ethers.formatUnits(amount1, symbol1 === "wPHRS" ? wDec : uDec) })}`);
        }

        if (!await approveIfNeeded(new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, wallet), wallet, provider, wallet.address, LP_ROUTER_ADDRESS, amount0, prefix, symbol0, lang)) {
            return false;
        }
        if (!await approveIfNeeded(new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet), wallet, provider, wallet.address, LP_ROUTER_ADDRESS, amount1, prefix, symbol1, lang)) {
            return false;
        }

        const slot0 = await pool.slot0();
        let initialSqrtPriceX96 = slot0.sqrtPriceX96;
        if (initialSqrtPriceX96 === 0n) {
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'poolNotInitialized')}`);
            initialSqrtPriceX96 = ethers.BigNumber.from("79228162514264337593543950336");
            const nonce = await provider.getTransactionCount(wallet.address, "pending");
            const initTx = await lpRouter.createAndInitializePoolIfNecessary(token0, token1, fee, initialSqrtPriceX96, { gasLimit: 300000, gasPrice: ethers.parseUnits("10", "gwei"), value: 0n, nonce });
            const initReceipt = await initTx.wait();
            if (initReceipt.status !== 1) {
                throw new Error(translate(lang, 'poolInitFailed', { hash: initTx.hash }));
            }
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'poolInitialized')}`);
        }

        const currentTick = slot0.tick;
        const tickSpacing = 60;
        const tickLower = Math.floor(Number(currentTick) / tickSpacing) * tickSpacing;
        const tickUpper = tickLower + tickSpacing * 4;

        const amount0Min = 0n;
        const amount1Min = 0n;

        const mintParams = {
            token0,
            token1,
            fee,
            tickLower,
            tickUpper,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min,
            amount1Min,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 1800
        };

        let gasLimit = 500000n;
        try {
            gasLimit = await lpRouter.estimateGas.mint(mintParams, { value: 1n });
            gasLimit = (gasLimit * 120n) / 100n;
        } catch (e) {
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'gasEstimateError')}`);
        }

        const nonce = await provider.getTransactionCount(wallet.address, "pending");
        console.log(`${nowStr(lang)} ${prefix} [DEBUG] Nonce: ${nonce}`); // Отладка nonce
        const tx = await lpRouter.mint(mintParams, { gasLimit, gasPrice: ethers.parseUnits("10", "gwei"), value: 1n, nonce });
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'liquidityTransactionSent', { hash: tx.hash })}`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
            throw new Error(translate(lang, 'liquidityFailed', { hash: tx.hash }));
        }
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'liquiditySuccessMsg', { hash: tx.hash })}`);
        fs.appendFileSync(successLog, `${nowStr(lang)} ${translate(lang, 'successfulWalletLiquidity', { address: wallet.address, hash: tx.hash })}\n`);
        return true;
    } catch (error) {
        console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'liquidityError', { message: error.message })}`);
        fs.appendFileSync(failedTxLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'liquidityError', { message: JSON.stringify(error) })}\n`); // Логирование полной ошибки
        if (error.code === -32000 || error.message?.includes("TX_REPLAY_ATTACK")) {
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'replayAttackMsg')}`);
            const delay = 2000 + Math.random() * 3000;
            await new Promise(r => setTimeout(r, delay));
            const freshNonce = await provider.getTransactionCount(wallet.address, "pending");
            console.log(`${nowStr(lang)} ${prefix} [DEBUG] Retry Nonce: ${freshNonce}`); // Отладка retry nonce
            const increasedGasLimit = (1000000n * BigInt(150)) / 100n;
            const lpRouter = new ethers.Contract(LP_ROUTER_ADDRESS, LP_ROUTER_ABI, wallet);
            try {
                const txRetry = await lpRouter.mint(mintParams, { nonce: freshNonce, gasLimit: increasedGasLimit, gasPrice: ethers.parseUnits("10", "gwei"), value: 1n });
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'liquidityTransactionSent', { hash: txRetry.hash })}`);
                const retryReceipt = await txRetry.wait();
                if (retryReceipt.status !== 1) {
                    throw new Error(translate(lang, 'liquidityFailed', { hash: txRetry.hash }));
                }
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryLiquidityMsg', { hash: txRetry.hash })}`);
                fs.appendFileSync(successLog, `${nowStr(lang)} ${translate(lang, 'successfulWalletLiquidityRetry', { address: wallet.address, hash: txRetry.hash })}\n`);
                return true;
            } catch (retryError) {
                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryError', { message: retryError.message })}`);
                fs.appendFileSync(failedTxLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'retryError', { message: JSON.stringify(retryError) })}\n`); // Логирование ошибки повтора
                return false;
            }
        }
        return false;
    }
}

async function convertLargeUSDCUSDT(wallet, provider, prefix, uDec, usdtDec, lang) {
    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'conversionStarted')}`);
    if (!await checkBalance(wallet, provider, prefix, lang)) {
        return false;
    }

    const usdcCt = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const usdtCt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
    const usdtBalance = await usdtCt.balanceOf(wallet.address);
    const usdcBalance = await usdcCt.balanceOf(wallet.address);
    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'balanceCheckUsdcUsdt', { usdc: ethers.formatUnits(usdcBalance, uDec), usdt: ethers.formatUnits(usdtBalance, usdtDec) })}`);

    if (usdcBalance > ethers.parseUnits("50", uDec) || usdtBalance > ethers.parseUnits("50", usdtDec)) {
        const isUsdcToUsdt = usdcBalance > ethers.parseUnits("20", uDec) && usdtBalance > ethers.parseUnits("50", usdtDec) ? Math.random() < 0.5 :
                             usdcBalance > ethers.parseUnits("20", uDec);
        const fromToken = isUsdcToUsdt ? USDC_ADDRESS : USDT_ADDRESS;
        const toToken = isUsdcToUsdt ? USDT_ADDRESS : USDC_ADDRESS;
        const fromSymbol = isUsdcToUsdt ? "USDC" : "USDT";
        const toSymbol = isUsdcToUsdt ? "USDT" : "USDC";
        const balance = isUsdcToUsdt ? usdcBalance : usdtBalance;
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'conversionDirection', { from: fromSymbol, to: toSymbol })}`);

        const conversionPercent = 0.2 + Math.random() * (0.3 - 0.2);
        const amountToConvert = (balance * BigInt(Math.floor(conversionPercent * 1000))) / 1000n;
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'conversionAmount', { amount: ethers.formatUnits(amountToConvert, isUsdcToUsdt ? uDec : usdtDec), symbol: fromSymbol })}`);

        if (await swap(wallet, provider, fromToken, toToken, amountToConvert, prefix, uDec, usdtDec, lang)) {
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'conversionCompleted')}`);
            fs.appendFileSync(successLog, `${nowStr(lang)} ${translate(lang, 'successfulWalletConvert', { address: wallet.address })}\n`);
            return true;
        }
        return false;
    } else {
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'noConversionNeeded')}`);
        return false;
    }
}

process.on('unhandledRejection', (error) => {
    console.error(`[GLOBAL] Unhandled Rejection: ${error.message}`);
});

// Основная функция
async function swapPHRS(idx, privKey, proxy, min, max, faucetExecuted, totalIterations, lang) {
    const prefix = `[${idx}] [${shortAddr(new ethers.Wallet(privKey).address)}]`;
    process.on('SIGINT', () => {
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'sigintInterrupt')}`);
        process.exit(1);
    });

    try {
        const provider = await getProviderWithProxy(proxy, 3, lang);
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'providerInitialized')}`);
        if (!provider) {
            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'providerNotInitialized')}`);
            return;
        }

        const wallet = new ethers.Wallet(privKey, provider);
        const address = wallet.address;

        if (faucetExecuted) {
            const faucetResult = await tryFaucetForWallet(idx, privKey, proxy);
            if (!faucetResult.success && !faucetResult.cooldown) {
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'faucetSkipped')}`);
                return;
            } else if (faucetResult.cooldown) {
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'faucetCooldown')}`);
            } else {
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'faucetSuccess')}`);
            }
        } else {
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'faucetSkipped')}`);
        }

        if (!await checkBalance(wallet, provider, prefix, lang)) {
            return;
        }

        const wphrsCt = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, provider);
        const usdcCt = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
        const usdtCt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
        const wDec = await wphrsCt.decimals();
        const uDec = await usdcCt.decimals();
        const usdtDec = await usdtCt.decimals();

        const checkAddress = (addr, name) => {
            if (!addr || !isAddress(addr)) {
                throw new Error(translate(lang, 'invalidAddress', { name, addr }));
            }
        };
        checkAddress(WPHRS_ADDRESS, "WPHRS");
        checkAddress(USDC_ADDRESS, "USDC");
        checkAddress(USDT_ADDRESS, "USDT");
        checkAddress(SWAP_ROUTER_ADDRESS, "SWAP_ROUTER");
        checkAddress(LP_ROUTER_ADDRESS, "LP_ROUTER");
        checkAddress(USDC_POOL_ADDRESS, "USDC_POOL");

        const wphrsThreshold = ethers.parseUnits("0.01", wDec);
        const wphrsUnwrapThreshold = ethers.parseEther("0.1");
        const maxAllowedSmallSwapUSDC = ethers.parseUnits("0.0000001", uDec);
        const maxAllowedSmallSwapWPHRS = ethers.parseUnits("0.0009", wDec);

        let successfulIterations = 0;
        let totalAttempts = 0;
        const maxTotalAttempts = totalIterations * 5; // 5 попытки на итерацию
        const liquidityIterations = Math.ceil(totalIterations / 2);
        const swapIterations = totalIterations - liquidityIterations;
        let liquidityCount = 0;
        let swapCount = 0;

        while (successfulIterations < totalIterations && totalAttempts < maxTotalAttempts) {
            totalAttempts++;
            let action = (liquidityCount < liquidityIterations && (liquidityCount < swapCount || swapCount >= swapIterations)) ? "liquidity" : "swap";
            console.log(`${nowStr(lang)} ${prefix} Action: ${action}`); // Убрано количество попыток

            try {
                let success = false;
                if (action === "liquidity") {
                    const randomFactorWPHRS = 0.8 + Math.random() * 0.3;
                    const randomFactorUSDC = 0.8 + Math.random() * 0.3;
                    const baseWPHRS = 0.001;
                    const baseUSDC = 0.01;
                    const finalWPHRS = (baseWPHRS * randomFactorWPHRS).toFixed(8);
                    const finalUSDC = (baseUSDC * randomFactorUSDC).toFixed(8);
                    const liquidityAmountWPHRS = ethers.parseUnits(finalWPHRS, wDec);
                    const liquidityAmountUSDC = ethers.parseUnits(finalUSDC, uDec);

                    const wphrsBalance = await wphrsCt.balanceOf(wallet.address);
                    const usdcBalance = await usdcCt.balanceOf(wallet.address);
                    if (wphrsBalance < liquidityAmountWPHRS || usdcBalance < liquidityAmountUSDC) {
                        console.log(`${nowStr(lang)} ${prefix} Insufficient balance for liquidity, trying conversion...`);
                        if (await convertPHRSToWPHRS(wallet, provider, prefix, lang) || await convertPHRSToUSDC(wallet, provider, prefix, lang)) {
                            success = await addLiquidity(wallet, provider, liquidityAmountWPHRS, liquidityAmountUSDC, prefix, wDec, uDec, lang);
                        }
                    } else {
                        success = await addLiquidity(wallet, provider, liquidityAmountWPHRS, liquidityAmountUSDC, prefix, wDec, uDec, lang);
                    }
                } else if (action === "swap") {
                    const usdcBalance = await usdcCt.balanceOf(wallet.address);
                    const usdtBalance = await usdtCt.balanceOf(wallet.address);
                    const wphrsBalance = await wphrsCt.balanceOf(wallet.address);
                    const isConversion = Math.random() < 0.5 && (usdcBalance > ethers.parseUnits("50", uDec) || usdtBalance > ethers.parseUnits("50", usdtDec));

                    if (isConversion) {
                        success = await convertLargeUSDCUSDT(wallet, provider, prefix, uDec, usdtDec, lang);
                    } else {
                        let fromToken, toToken, amountInEth, symbolIn, symbolOut, decimals;
                        if (wphrsBalance > wphrsThreshold) {
                            fromToken = WPHRS_ADDRESS;
                            toToken = USDC_ADDRESS;
                            const minAmount = 0.001;
                            const maxAmount = 0.022;
                            const randomPercent = 0.2 + Math.random() * 0.8;
                            amountInEth = (minAmount + (maxAmount - minAmount) * randomPercent).toFixed(6);
                            symbolIn = "WPHRS";
                            symbolOut = "USDC";
                            decimals = wDec;
                        } else if (usdcBalance > 0n) {
                            fromToken = USDC_ADDRESS;
                            toToken = WPHRS_ADDRESS;
                            const minAmount = 0.0000001;
                            const maxAmount = 0.01;
                            const randomPercent = 0.2 + Math.random() * 0.8;
                            amountInEth = (minAmount + (maxAmount - minAmount) * randomPercent).toFixed(6);
                            symbolIn = "USDC";
                            symbolOut = "WPHRS";
                            decimals = uDec;
                        } else {
                            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'noTokensForSwap')}`);
                            successfulIterations++;
                            continue;
                        }

                        const amountInWei = ethers.parseUnits(amountInEth, decimals);
                        if (amountInWei === 0n) {
                            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'zeroAmount')}`);
                            successfulIterations++;
                            continue;
                        }

                        const fromBalance = await (fromToken === WPHRS_ADDRESS ? wphrsCt : usdcCt).balanceOf(wallet.address);
                        if (fromBalance < amountInWei) {
                            console.log(`${nowStr(lang)} ${prefix} Insufficient balance for ${symbolIn} (${ethers.formatUnits(fromBalance, decimals)} < ${amountInEth}), trying conversion...`);
                            if (symbolIn === "WPHRS" && await convertPHRSToWPHRS(wallet, provider, prefix, lang)) {
                                success = await swap(wallet, provider, fromToken, toToken, amountInWei, prefix, wDec, uDec, lang);
                            } else if (symbolIn === "USDC" && await convertPHRSToUSDC(wallet, provider, prefix, lang)) {
                                success = await swap(wallet, provider, fromToken, toToken, amountInWei, prefix, wDec, uDec, lang);
                            } else if (await convertPHRSToWPHRS(wallet, provider, prefix, lang)) {
                                fromToken = WPHRS_ADDRESS;
                                toToken = USDC_ADDRESS;
                                amountInEth = "0.03";
                                amountInWei = ethers.parseUnits(amountInEth, wDec);
                                success = await swap(wallet, provider, fromToken, toToken, amountInWei, prefix, wDec, uDec, lang);
                            }
                        } else {
                            success = await swap(wallet, provider, fromToken, toToken, amountInWei, prefix, wDec, uDec, lang);
                        }
                    }
                }

                if (!success && (action === "liquidity" || action === "swap")) {
                    successfulIterations++; // Засчитываем как неудачную итерацию
                    continue;
                }

                if (success) {
                    successfulIterations++;
                    if (action === "liquidity") liquidityCount++;
                    else swapCount++;
                    console.log(`${nowStr(lang)} ${prefix} Iteration completed (Total: ${successfulIterations}/${totalIterations})`);
                }

                const wphrsBalanceCheck = await wphrsCt.balanceOf(wallet.address);
                if (wphrsBalanceCheck > wphrsUnwrapThreshold && Math.random() < 0.3) {
                    const unwrapPercent = 0.2 + Math.random() * (0.3 - 0.2);
                    const amountToUnwrap = (wphrsBalanceCheck * BigInt(Math.floor(unwrapPercent * 1000))) / 1000n;
                    const wphrs = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, wallet);
                    const nonce = await provider.getTransactionCount(wallet.address, "pending");
                    const tx = await wphrs.withdraw(amountToUnwrap, { gasLimit: 300000n, gasPrice: ethers.parseUnits("100", "gwei"), nonce });
                    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapTriggered')}`);
                    const receipt = await waitWithTimeout(tx, TX_TIMEOUT, lang);
                    if (receipt.status !== 1) {
                        throw new Error(translate(lang, 'unwrapFailedTx', { hash: tx.hash }));
                    }
                    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'unwrapSuccess', { hash: tx.hash })}`);
                }
            } catch (error) {
                if (error.message.includes('request timeout')) {
                    console.error(`${nowStr(lang)} ${prefix} TX_TIMEOUT`);
                    successfulIterations++; // Засчитываем как неудачную итерацию при тайм-ауте
                    continue;
                }
                console.error(`${nowStr(lang)} ${prefix} Error: ${error.message}`);
            }

            const sleepTime = Math.floor(Math.random() * (MAX_SLEEP - MIN_SLEEP) + MIN_SLEEP);
            await safeSleep(sleepTime * 1000);
        }

        // Завершение работы аккаунта после достижения totalIterations
        console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'walletCompleted', { address: address })}`);
    } catch (error) {
        console.error(`${nowStr(lang)} ${prefix} Error: ${error.message}`);
    }
}

// Функции конвертации (без изменений)
async function convertPHRSToWPHRS(wallet, provider, prefix, lang) {
    const phrsBalance = await provider.getBalance(wallet.address);
    if (phrsBalance <= 0n) {
        console.log(`${nowStr(lang)} ${prefix} No PHRS available for conversion`);
        return false;
    }

    const wphrsCt = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, wallet);
    try {
        const tx = await wphrsCt.deposit({ value: phrsBalance, gasLimit: 300000n, gasPrice: ethers.parseUnits("100", "gwei") });
        console.log(`${nowStr(lang)} ${prefix} Converting PHRS to WPHRS, TX: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            console.log(`${nowStr(lang)} ${prefix} PHRS to WPHRS conversion successful`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`${nowStr(lang)} ${prefix} Error converting PHRS to WPHRS: ${error.message}`);
        return false;
    }
}

async function convertPHRSToUSDC(wallet, provider, prefix, lang) {
    const phrsBalance = await provider.getBalance(wallet.address);
    if (phrsBalance <= 0n) {
        console.log(`${nowStr(lang)} ${prefix} No PHRS available for conversion`);
        return false;
    }

    const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
    const amountInWei = phrsBalance;
    try {
        const tx = await swapRouter.swapExactETHForTokens(0, [WETH_ADDRESS, USDC_ADDRESS], wallet.address, Math.floor(Date.now() / 1000) + 1800, { value: amountInWei, gasLimit: 300000n, gasPrice: ethers.parseUnits("100", "gwei") });
        console.log(`${nowStr(lang)} ${prefix} Converting PHRS to USDC, TX: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            console.log(`${nowStr(lang)} ${prefix} PHRS to USDC conversion successful`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`${nowStr(lang)} ${prefix} Error converting PHRS to USDC: ${error.message}`);
        return false;
    }
}

// Вспомогательная функция для обмена PHRS → WPHRS
async function convertPHRSToWPHRS(wallet, provider, prefix, lang) {
    const phrsBalance = await provider.getBalance(wallet.address);
    if (phrsBalance <= 0n) {
        console.log(`${nowStr(lang)} ${prefix} No PHRS available for conversion`);
        return false;
    }

    const wphrsCt = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, wallet);
    try {
        const tx = await wphrsCt.deposit({ value: phrsBalance, gasLimit: 300000n, gasPrice: ethers.parseUnits("100", "gwei") });
        console.log(`${nowStr(lang)} ${prefix} Converting PHRS to WPHRS, TX: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            console.log(`${nowStr(lang)} ${prefix} PHRS to WPHRS conversion successful`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`${nowStr(lang)} ${prefix} Error converting PHRS to WPHRS: ${error.message}`);
        return false;
    }
}

// Вспомогательная функция для обмена PHRS → USDC (пример, требует настройки)
async function convertPHRSToUSDC(wallet, provider, prefix, lang) {
    const phrsBalance = await provider.getBalance(wallet.address);
    if (phrsBalance <= 0n) {
        console.log(`${nowStr(lang)} ${prefix} No PHRS available for conversion`);
        return false;
    }

    const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
    const amountInWei = phrsBalance;
    try {
        const tx = await swapRouter.swapExactETHForTokens(0, [WETH_ADDRESS, USDC_ADDRESS], wallet.address, Math.floor(Date.now() / 1000) + 1800, { value: amountInWei, gasLimit: 300000n, gasPrice: ethers.parseUnits("100", "gwei") });
        console.log(`${nowStr(lang)} ${prefix} Converting PHRS to USDC, TX: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            console.log(`${nowStr(lang)} ${prefix} PHRS to USDC conversion successful`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`${nowStr(lang)} ${prefix} Error converting PHRS to USDC: ${error.message}`);
        return false;
    }
}

async function waitWithTimeout(tx, timeoutMs = TX_TIMEOUT, lang) {
    try {
        return await Promise.race([
            tx.wait(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(translate(lang, 'transactionTimeout'))), timeoutMs)
            )
        ]);
    } catch (error) {
        fs.appendFileSync(failedTxLog, `${nowStr(lang)} ${translate(lang, 'transactionTimeoutLog', { hash: tx.hash })}\n`);
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    let lang = 'EN';
    console.log(`${nowStr(lang)} [INIT] ${translate(lang, 'initScript')}`);

    const mapLang = { ENG: 'EN', EN: 'EN', RU: 'RU', RUS: 'RU' };

    while (true) {
        const langInput = prompt("Выберите язык (ENG/RU): ").toUpperCase();
        lang = mapLang[langInput];
        if (lang) {
            console.log(`${nowStr(lang)} [INIT] ${translate(lang, 'languageSelected', { lang })}`);
            break;
        } else {
            console.log(`${nowStr(lang)} [ERROR] ${translate(lang, 'invalidChoice')}`);
        }
    }

    let maxThreads;
    while (true) {
        const input = prompt(translate(lang, 'threadsPrompt'));
        maxThreads = parseInt(input);
        if (isNaN(maxThreads) || maxThreads < 1 || maxThreads > 100) {
            console.log(chalk.red(`${nowStr(lang)} [ERROR] ${translate(lang, 'invalidThreads')}`));
        } else {
            console.log(`${nowStr(lang)} [INFO] ${translate(lang, 'threadsSelected', { threads: maxThreads })}`);
            break;
        }
    }

    console.log(chalk.yellow(`${nowStr(lang)} [MENU] ${translate(lang, 'menuDisplay')}`));
    console.log(`1. ${translate(lang, 'option1')}`);
    console.log(`2. ${translate(lang, 'option2')}`);
    console.log(`3. ${translate(lang, 'option3')}`);
    console.log(`4. ${translate(lang, 'option4')}`);
    console.log(`5. ${translate(lang, 'option5')}`);
    const choice = prompt(translate(lang, 'selectOption'));

    const privs = loadLines(PRIV_FILE);
    const proxies = loadLines(PROXIES_FILE, { allowNullIfEmpty: true });

    if (!privs || privs.length === 0) {
        console.error(`${nowStr(lang)} [ERROR] ${translate(lang, 'errorPrivs', { file: PRIV_FILE })}`);
        return;
    }

    console.log(`${nowStr(lang)} [INFO] ${translate(lang, 'scriptStarted', { choice })}`);

    let faucetExecuted = false;
    let shuffledPrivs = [...privs];
    let totalIterations;

    if (choice === '1' || choice === '2') {
        shuffledPrivs = [...privs].sort(() => Math.random() - 0.5);

        while (true) {
            const input = prompt(translate(lang, 'iterationsPrompt'));
            totalIterations = parseInt(input);
            if (isNaN(totalIterations) || totalIterations < 5 || totalIterations > 25) {
                console.log(chalk.red(`${nowStr(lang)} [ERROR] ${translate(lang, 'invalidIterations', { min: 5, max: 25 })}`));
            } else {
                console.log(`${nowStr(lang)} [INFO] ${translate(lang, 'iterationsSelected', { iterations: totalIterations })}`);
                break;
            }
        }

        if (choice === '1') {
            console.log(chalk.cyan(`${nowStr(lang)} [INFO] ${translate(lang, 'faucetStarted')}`));
            for (let i = 0; i < privs.length; i++) {
                const priv = privs[i];
                const proxy = proxies[i % proxies.length];
                const prefix = `[${i + 1}] [${shortAddr(new ethers.Wallet(priv).address)}]`;
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'faucetStarted')}`);
                await tryFaucetForWallet(i + 1, priv, proxy);
                const delay = 2000 + Math.random() * 3000;
                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'delayMsg', { delay: (delay / 1000).toFixed(1) })}`);
                await sleep(delay);
            }
            faucetExecuted = true;
        } else {
            console.log(chalk.cyan(`${nowStr(lang)} [INFO] ${translate(lang, 'faucetSkipped')}`));
        }

        const min = 0.002;
        const max = 0.005;
        const repeat = 2 + Math.floor(Math.random() * 2);
        const limit = pLimit(maxThreads);

        for (let r = 0; r < repeat; r++) {
            console.log(`\n===== [${translate(lang, 'cycleCompleted', { cycle: r + 1, total: repeat })}] =====`);
            const delay = 500 + Math.random() * 1000;
            await sleep(delay);
            console.log(chalk.blue(`${nowStr(lang)} [INFO] ${translate(lang, 'delayMsg', { delay: (delay / 1000).toFixed(2) })}`));

            const tasks = shuffledPrivs.map((priv, i) => {
                const proxy = proxies[i % proxies.length];
                return limit(async () => {
                    let attempt = 0;
                    const maxAttempts = 3;
                    while (attempt < maxAttempts) {
                        try {
                            await swapPHRS(i + 1, priv, proxy, min, max, faucetExecuted, totalIterations, lang);
                            break; // Успешное завершение, выходим из попыток
                        } catch (error) {
                            if (error.code === 429 || error.message.includes("limit exceeded") || error.message.includes("Request too fast")) {
                                attempt++;
                                console.error(`${nowStr(lang)} [${i + 1}] ${translate(lang, 'error429', { attempt, maxAttempts, message: error.message })}`);
                                if (attempt < maxAttempts) {
                                    const retryDelay = 60000 + Math.random() * 30000;
                                    console.log(`${nowStr(lang)} [${i + 1}] ${translate(lang, 'retryWait', { delay: (retryDelay / 1000 / 60).toFixed(1) })}`);
                                    await sleep(retryDelay);
                                } else {
                                    console.error(`${nowStr(lang)} [${i + 1}] ${translate(lang, 'allAttemptsExhausted', { maxAttempts })}`);
                                    fs.appendFileSync(balanceLog, `${nowStr(lang)} [${i + 1}] ${translate(lang, 'allAttemptsExhaustedLog', { message: error.message })}\n`);
                                }
                            } else {
                                console.error(`${nowStr(lang)} [${i + 1}] ${translate(lang, 'generalError', { message: error.message })}`);
                                fs.appendFileSync(balanceLog, `${nowStr(lang)} [${i + 1}] ${translate(lang, 'generalErrorLog', { message: error.message })}\n`);
                                break;
                            }
                        }
                    }
                });
            });
            await Promise.all(tasks);
            console.log(chalk.green(`${nowStr(lang)} [INFO] ${translate(lang, 'cycleCompleted', { cycle: r + 1, total: repeat })}`));
        }
    } else if (choice === '3') {
        console.log(chalk.cyan(`${nowStr(lang)} [INFO] ${translate(lang, 'liquidityCompleted')}`));
        shuffledPrivs = [...privs].sort(() => Math.random() - 0.5);

        while (true) {
            const input = prompt(translate(lang, 'iterationsLiquidityPrompt'));
            totalIterations = parseInt(input);
            if (isNaN(totalIterations) || totalIterations < 1 || totalIterations > 100) {
                console.log(chalk.red(`${nowStr(lang)} [ERROR] ${translate(lang, 'invalidIterations', { min: 1, max: 100 })}`));
            } else {
                console.log(`${nowStr(lang)} [INFO] ${translate(lang, 'iterationsSelected', { iterations: totalIterations })}`);
                break;
            }
        }

        const limit = pLimit(maxThreads);

        const tasks = shuffledPrivs.map((priv, i) => {
            const proxy = proxies[i % proxies.length];
            const prefix = `[${i + 1}] [${shortAddr(new ethers.Wallet(priv).address)}]`;
            return limit(async () => {
                let attempt = 0;
                const maxAttempts = 3;
                while (attempt < maxAttempts) {
                    try {
                        const provider = await getProviderWithProxy(proxy, 3, lang);
                        const wallet = new ethers.Wallet(priv, provider);
                        const wphrsCt = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, provider);
                        const usdcCt = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
                        const wDec = await wphrsCt.decimals();
                        const uDec = await usdcCt.decimals();

                        let successfulIterations = 0;
                        while (successfulIterations < totalIterations) {
                            const randomFactorWPHRS = 0.8 + Math.random() * 0.3;
                            const randomFactorUSDC = 0.8 + Math.random() * 0.3;
                            const baseWPHRS = 0.001;
                            const baseUSDC = 0.01;
                            const finalWPHRS = (baseWPHRS * randomFactorWPHRS).toFixed(8);
                            const finalUSDC = (baseUSDC * randomFactorUSDC).toFixed(8);
                            const amountWPHRS = ethers.parseUnits(finalWPHRS, wDec);
                            const amountUSDC = ethers.parseUnits(finalUSDC, uDec);

                            if (await addLiquidity(wallet, provider, amountWPHRS, amountUSDC, prefix, wDec, uDec, lang)) {
                                successfulIterations++;
                                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'liquidityCompleted')} (${successfulIterations}/${totalIterations})`);
                                fs.appendFileSync(successLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'liquidityCompleted')}\n`);
                            }
                            const delay = 2000 + Math.random() * 3000;
                            await sleep(delay);
                        }
                        break; // Успешное завершение всех итераций
                    } catch (error) {
                        if (error.code === 429 || error.message.includes("limit exceeded") || error.message.includes("Request too fast")) {
                            attempt++;
                            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'error429', { attempt, maxAttempts, message: error.message })}`);
                            if (attempt < maxAttempts) {
                                const retryDelay = 60000 + Math.random() * 30000;
                                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryWait', { delay: (retryDelay / 1000 / 60).toFixed(1) })}`);
                                await sleep(retryDelay);
                            } else {
                                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'allAttemptsExhausted', { maxAttempts })}`);
                                fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'allAttemptsExhaustedLog', { message: error.message })}\n`);
                            }
                        } else {
                            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'generalError', { message: error.message })}`);
                            fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'generalErrorLog', { message: error.message })}\n`);
                            break;
                        }
                    }
                }
            });
        });

        await Promise.all(tasks);
        console.log(chalk.green(`${nowStr(lang)} [INFO] ${translate(lang, 'liquidityCompleted')}`));
    } else if (choice === '4') {
        console.log(chalk.cyan(`${nowStr(lang)} [INFO] ${translate(lang, 'swapsCompleted')}`));
        shuffledPrivs = [...privs].sort(() => Math.random() - 0.5);

        while (true) {
            const input = prompt(translate(lang, 'iterationsSwapPrompt'));
            totalIterations = parseInt(input);
            if (isNaN(totalIterations) || totalIterations < 1 || totalIterations > 100) {
                console.log(chalk.red(`${nowStr(lang)} [ERROR] ${translate(lang, 'invalidIterations', { min: 1, max: 100 })}`));
            } else {
                console.log(`${nowStr(lang)} [INFO] ${translate(lang, 'iterationsSelected', { iterations: totalIterations })}`);
                break;
            }
        }

        const limit = pLimit(maxThreads);

        const tasks = shuffledPrivs.map((priv, i) => {
            const proxy = proxies[i % proxies.length];
            const prefix = `[${i + 1}] [${shortAddr(new ethers.Wallet(priv).address)}]`;
            return limit(async () => {
                let attempt = 0;
                const maxAttempts = 3;
                while (attempt < maxAttempts) {
                    try {
                        const provider = await getProviderWithProxy(proxy, 3, lang);
                        const wallet = new ethers.Wallet(priv, provider);
                        const wphrsCt = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, provider);
                        const usdcCt = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
                        const usdtCt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
                        const wDec = await wphrsCt.decimals();
                        const uDec = await usdcCt.decimals();
                        const usdtDec = await usdtCt.decimals();

                        let successfulIterations = 0;
                        while (successfulIterations < totalIterations) {
                            const isConversion = Math.random() < 0.5;
                            if (isConversion) {
                                if (await convertLargeUSDCUSDT(wallet, provider, prefix, uDec, usdtDec, lang)) {
                                    successfulIterations++;
                                    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'swapsCompleted')} (${successfulIterations}/${totalIterations})`);
                                    fs.appendFileSync(successLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'swapsCompleted')}\n`);
                                }
                            } else {
                                const directions = [
                                    { from: WPHRS_ADDRESS, to: USDC_ADDRESS, amount: "0.01", dec: wDec, fromSym: "WPHRS", toSym: "USDC" },
                                    { from: USDC_ADDRESS, to: WPHRS_ADDRESS, amount: "0.001", dec: uDec, fromSym: "USDC", toSym: "WPHRS" }
                                ];
                                const direction = directions[Math.floor(Math.random() * directions.length)];
                                const amountInWei = ethers.parseUnits(direction.amount, direction.dec);
                                if (await swap(wallet, provider, direction.from, direction.to, amountInWei, prefix, wDec, uDec, lang)) {
                                    successfulIterations++;
                                    console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'swapsCompleted')} ${direction.fromSym} → ${direction.toSym} (${successfulIterations}/${totalIterations})`);
                                    fs.appendFileSync(successLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'swapsCompleted')} ${direction.fromSym} → ${direction.toSym}\n`);
                                }
                            }
                            const delay = 2000 + Math.random() * 3000;
                            await sleep(delay);
                        }
                        break; // Успешное завершение всех итераций
                    } catch (error) {
                        if (error.code === 429 || error.message.includes("limit exceeded") || error.message.includes("Request too fast")) {
                            attempt++;
                            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'error429', { attempt, maxAttempts, message: error.message })}`);
                            if (attempt < maxAttempts) {
                                const retryDelay = 60000 + Math.random() * 30000;
                                console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'retryWait', { delay: (retryDelay / 1000 / 60).toFixed(1) })}`);
                                await sleep(retryDelay);
                            } else {
                                console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'allAttemptsExhausted', { maxAttempts })}`);
                                fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'allAttemptsExhaustedLog', { message: error.message })}\n`);
                            }
                        } else {
                            console.error(`${nowStr(lang)} ${prefix} ${translate(lang, 'generalError', { message: error.message })}`);
                            fs.appendFileSync(balanceLog, `${nowStr(lang)} ${prefix} ${translate(lang, 'generalErrorLog', { message: error.message })}\n`);
                            break;
                        }
                    }
                }
            });
        });

        await Promise.all(tasks);
        console.log(chalk.green(`${nowStr(lang)} [INFO] ${translate(lang, 'swapsCompleted')}`));
    } else if (choice === '5') {
        console.log(chalk.cyan(`${nowStr(lang)} [INFO] ${translate(lang, 'faucetCompleted')}`));
        for (let i = 0; i < privs.length; i++) {
            const priv = privs[i];
            const proxy = proxies[i % proxies.length];
            const prefix = `[${i + 1}] [${shortAddr(new ethers.Wallet(priv).address)}]`;
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'faucetStarted')}`);
            await tryFaucetForWallet(i + 1, priv, proxy);
            const delay = 2000 + Math.random() * 3000;
            console.log(`${nowStr(lang)} ${prefix} ${translate(lang, 'delayMsg', { delay: (delay / 1000).toFixed(1) })}`);
            await sleep(delay);
        }
        console.log(chalk.green(`${nowStr(lang)} [INFO] ${translate(lang, 'faucetCompleted')}`));
    } else {
        console.log(chalk.red(`${nowStr(lang)} [ERROR] ${translate(lang, 'invalidChoice')}`));
    }

    console.log(`${nowStr(lang)} [INFO] ${translate(lang, 'scriptCompleted')}`);
}

main();