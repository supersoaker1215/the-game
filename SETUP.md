# 🎮 The Game — Setup Guide

Yo — taking the wheel for a bit. Here's the full setup. Takes ~20 min and then you can work with Claude Code exactly the way I do. If anything breaks, screenshot the error and send it to me.

## The game lives in two places

- **Code:** this repo — `https://github.com/supersoaker1215/the-game` (you've got collaborator access, accept the email invite first)
- **Live playable version:** `https://supersoaker1215.github.io/the-game/` (auto-updates ~60s after anyone pushes)

---

## Step 1 — Install Git

Open **Terminal** (Cmd+Space → "Terminal"). Paste:

```bash
git --version
```

If it prints a version, you're good. If it prompts to install developer tools, click Install and wait.

---

## Step 2 — Install Node + Claude Code

In Terminal, paste these one at a time:

```bash
brew install node
```

```bash
npm install -g @anthropic-ai/claude-code
```

If `brew` isn't installed, run this first:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

…then re-run the two install commands above.

Sign in once:

```bash
claude
```

It opens a browser to log in with your Anthropic account. (Need a Claude subscription for Claude Code — sign up at `https://claude.ai` if you don't have one.)

---

## Step 3 — Clone the project

```bash
cd ~
git clone https://github.com/supersoaker1215/the-game.git "The Game"
cd "The Game"
```

You should now see a **The Game** folder in your home directory.

---

## Step 4 — Install the auto-push hook

This makes every commit push to GitHub automatically — same setup I have. Paste the whole block:

```bash
mkdir -p ".git/hooks"
cat > ".git/hooks/post-commit" << 'EOF'
#!/bin/sh
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
if [ "$branch" = "main" ]; then
  echo "[auto-push] main → origin/main"
  git push origin main 2>&1 || echo "[auto-push] push failed — local commit kept; retry with: git push origin main"
else
  echo "[auto-push] on branch '$branch' (not main) — skipping push"
fi
EOF
chmod +x ".git/hooks/post-commit"
echo "✓ Auto-push hook installed"
```

---

## Step 5 — Install the Sync button on your Desktop

A one-click "pull my brother's latest" button. Paste this whole block:

```bash
cat > "$HOME/Desktop/Sync The Game.command" << 'EOF'
#!/bin/bash
cd "$HOME/The Game" || { echo "✗ Project folder not found at ~/The Game"; sleep 5; exit 1; }
clear
echo "================================"
echo "  Sync The Game ← GitHub"
echo "================================"
echo ""
if ! git diff --quiet HEAD -- 2>/dev/null; then
  echo "⚠️  You have uncommitted local changes:"
  echo ""
  git status --short
  echo ""
  echo "Commit them (they'll auto-push) or discard, then re-run."
  echo ""
  read -p "Press Enter to close..." dummy
  exit 1
fi
before=$(git rev-parse HEAD)
echo "Checking for updates on GitHub..."
echo ""
if git pull --ff-only origin main; then
  after=$(git rev-parse HEAD)
  echo ""
  if [ "$before" = "$after" ]; then
    echo "✓ Already up to date."
  else
    echo "✓ Updated. Pulled these commits:"
    echo ""
    git log --oneline --no-decorate "$before..$after"
  fi
else
  echo ""
  echo "✗ Pull failed. Run manually: cd '$HOME/The Game' && git pull origin main"
fi
echo ""
read -p "Press Enter to close..." dummy
EOF
chmod +x "$HOME/Desktop/Sync The Game.command"
echo "✓ Sync button created on Desktop"
```

There's now a **Sync The Game** icon on your Desktop. Double-click any time to pull my latest commits.

**First time you double-click:** Mac may say "untrusted developer." Right-click the icon → Open → Open. After that, it just runs.

---

## Step 6 (optional) — Local preview server

Want to see changes instantly instead of waiting for the live URL? In Terminal:

```bash
cd ~/The\ Game
python3 -m http.server 8080
```

Open `http://localhost:8080/` in your browser. Leave that Terminal tab running. Every edit shows up on refresh.

Skip this if you don't care about instant feedback — the live URL works fine, just ~60s slower.

---

## Step 7 — Your daily workflow

Every time you sit down to work:

1. **Double-click the Sync The Game button on your Desktop** to grab my latest.
2. **Open Terminal and start Claude:**
   ```bash
   cd ~/The\ Game
   claude
   ```
3. **Tell Claude what you want.** It edits, commits, and auto-pushes. The live URL updates in ~60s.
4. **When done, just close Claude.** Everything is already on GitHub.

---

## What if we both work at the same time?

Git will reject the second push with a "diverged" error. The fix:

```bash
cd ~/The\ Game
git pull --rebase origin main
git push origin main
```

This replays your local commits on top of mine. If two of us edited the same line, git pauses and tells you which file is conflicting. Fix it, then:

```bash
git add <file>
git rebase --continue
```

Rare. To avoid entirely: text me before you start a session.

---

## Quick reference card

| Action | How |
|---|---|
| Get my latest work | Double-click **Sync The Game** on Desktop |
| Start a Claude session | `cd ~/The Game && claude` |
| Push your work | Automatic — happens on every commit |
| Run local preview | `cd ~/The Game && python3 -m http.server 8080` then open `http://localhost:8080/` |
| See what changed recently | `cd ~/The Game && git log --oneline -10` |
| Undo a local change before commit | `git checkout -- <file>` |
| Revert a bad commit that already pushed | `git revert <commit-hash>` (auto-pushes) |

---

## URLs to bookmark

- **GitHub repo:** `https://github.com/supersoaker1215/the-game`
- **Live game:** `https://supersoaker1215.github.io/the-game/`
- **Project folder on your Mac:** `~/The Game/`

---

That's it. Once you're set up, just tell Claude what to build — it knows the codebase. Have fun.
