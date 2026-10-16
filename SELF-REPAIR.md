# Self-repair: how the website fixes itself

**When something breaks**
- It records what failed and where. It never records photos, member numbers, emails or passwords.
- Known problems get a fix written and tested ahead of time. The safe ones are applied straight away and can be undone:
  - An extra feature that keeps crashing is paused. The doors are watched either way.
  - A retired AI model is swapped for the default one.
  - Old photos past their keep time are cleared from a full disk.
- Other known problems need a person: a wrong API key, no credit left, or a broken email password. For those you get an email saying exactly what to do.
- A new problem that keeps happening goes to Claude. Claude writes the smallest fix, and the fix then has to pass the checks below.

**When you ask**
- Admin page > **Self-repair and changes** > "Ask for a change". Write what you want in plain words.
- It reads the project map and the right files, writes the change, and the change then has to pass the checks below.

**Checks every code change must pass before it ships**
1. It stays small and only touches files it is allowed to change. It never touches detection or its instructions, sign-in and security, member-number encryption, prices and payments, or privacy and photo keep times. It adds no packages, shell commands, outside scripts, network calls or file deletion.
2. A second, independent review checks it against the site's rules: plain words, phones first, every value escaped, nothing nearby broken. One revision is allowed.
3. It is applied to a full copy of the website. That copy must pass `node --check`, the full QA check, and start up and answer its pages.
4. It goes to GitHub as a pull request, and you get an email with the exact change: **Approve and deploy** / **Reject**.
5. After it goes live it is watched for 30 minutes. If the same error comes back, or the site keeps crashing, the old code is put back by itself and you are told.

**One-time setup on Render (Environment)**
- `GITHUB_TOKEN`: on github.com go to Settings > Developer settings > Fine-grained tokens > Generate.
  - Repository access: only this repository.
  - Permissions: Contents **Read and write**, Pull requests **Read and write**.
- `GITHUB_REPO`: `your-user/your-repo`.
- `GITHUB_DIR`: set this only if the code is in a folder inside the repo.
- Render must deploy automatically when `main` changes. That is Render's default ("Auto-Deploy: Yes").
- `SUPPORT_EMAIL` and SMTP must be set, so the emails arrive.

Without GitHub connected, tested changes are emailed to you instead of shipped.

**Limits** (all optional)
- `SELF_FIX_DAILY`: error fixes a day. Default 2.
- `SELF_CHANGE_DAILY`: your requests a day. Default 10.
- `SELF_FIX_CALLS_DAILY`: hard cap on AI calls. Default 10 (keeps the cost of self-repair small; raise it only if fixes run out of calls).
- `SELF_FIX_MODEL`: default `claude-sonnet-4-6`.
- `SELF_FIX=off` turns all of this off.
- `SELF_FIX_AUTO=on` lets small, low-risk error fixes ship without waiting. You still get the email and Undo.

**Who can approve, undo or change anything:** only you. That means the signed buttons in your email, which last 14 days and always ask you to confirm, or the admin page. Gyms never see any of this.
