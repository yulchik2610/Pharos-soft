==============================
PHAROS SCRIPT - USAGE GUIDE
==============================

✅ 1. Requirements:
-------------------
- Node.js v16 or higher must be installed.
  Download: https://nodejs.org

- Required files in the script folder:
  • priv.txt       → One private key per line
  • proxies.txt    → One proxy per line (optional but recommended)

✅ 2. Getting into the Project Folder:
--------------------------------------
In Command Prompt (Windows), use:

    cd Desktop\Pharos-soft

(Change the path if you saved the folder elsewhere)

✅ 3. Install Dependencies:
---------------------------
Run the following command in the project folder:

    npm install

It will install all required Node.js packages:

    • axios              → For making HTTP requests
    • chalk              → For colorful console output
    • ethers             → Web3 library for blockchain interaction
    • https-proxy-agent  → For working with proxy servers
    • p-limit            → For controlling thread concurrency
    • prompt-sync        → For terminal input prompts

✅ 4. Running the Script:
-------------------------
Start the script using:

    node main.js

You will see a menu:

    1 - Start with faucet
    2 - Start without faucet
    3 - Full liquidity launch
    4 - Full swaps and conversions
    5 - Faucet only (quick mode)

✅ 5. Script Prompts:
---------------------
After choosing an option, the script will ask:

    • Number of threads (e.g. 5–50)
    • Number of iterations per wallet (e.g. 10–25)

✅ 6. Logs:
-----------
Logs will be saved in the /logs/ folder:

    • logs/success_log/ → successful operations
    • logs/failed_log/  → failed attempts

✅ 7. Notes:
------------
- To reinstall missing modules: run `npm install`
- Make sure your priv.txt and proxies.txt are properly formatted
- Default encoding: UTF-8
