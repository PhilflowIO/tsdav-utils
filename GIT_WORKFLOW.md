# Git & GitHub Workflow for tsdav-utils

## 🚨 Critical Rules (Read First)

### Git Identity Configuration

**ABSOLUTE REQUIREMENT:** All commits must be attributed to Philipp.
```bash
# Run these commands BEFORE any commit
git config user.name "PhilflowIO"
git config user.email "tech@philflow.io"  

# VERIFY configuration
git config user.name    # Should output: Philipp
git config user.email   # Should output: your email
```

### Forbidden Practices

❌ **NEVER** use Claude signatures in commits
❌ **NEVER** commit without verifying git identity first
❌ **NEVER** force push to main branch
❌ **NEVER** commit secrets, API keys, or credentials

---

## Available Tools

You have three tools for Git/GitHub operations:

### 1. bash_tool (Standard Git)
Use for basic operations:
```bash
git status
git add .
git commit -m "message"
git push origin branch-name
git checkout -b feature/new-feature
```

### 2. git MCP Server
Use for advanced operations:
- Code search across history
- Complex branch operations
- Commit history analysis
- Blame tracking

### 3. gh CLI (GitHub)
Use for GitHub-specific operations:
```bash
gh repo create
gh issue create
gh pr create
gh pr merge
gh release create
```

**Choose the right tool for each task.** Use all three intensively.

---

## Repository Setup

### Initial Setup (First Time)
```bash
# Create directory and initialize
mkdir tsdav-utils
cd tsdav-utils
git init

# Configure identity (REQUIRED)
git config user.name "PhilflowIO"
git config user.email "tech@philflow.io"

# Verify
git config user.name
git config user.email

# Create initial files
npm init -y
# ... create src/, package.json, etc.

# Initial commit
git add .
git commit -m "Initial project scaffold"

# Create GitHub repository
gh repo create tsdav-utils \
  --public \
  --source=. \
  --remote=origin \
  --description="Field-agnostic utility layer for tsdav CalDAV/CardDAV operations"

# Push initial commit
git push -u origin main
```

---

## Branching Strategy

### Branch Types

**main**
- Production-ready code only
- Protected branch (no direct commits)
- Only accepts PRs

**develop** (optional)
- Integration branch
- Staging area for features

**feature/***
- Feature development
- Examples: `feature/core-implementation`, `feature/vcard-support`

**fix/***
- Bug fixes
- Examples: `fix/property-preservation`, `fix/timezone-handling`

**docs/***
- Documentation only
- Examples: `docs/readme-examples`, `docs/api-reference`

### Creating Branches
```bash
# Feature branch
git checkout -b feature/updateFields-implementation

# Bug fix branch
git checkout -b fix/immutability-bug

# Documentation branch
git checkout -b docs/usage-examples
```

---

## Commit Guidelines

### Commit Message Format

**Structure:**
```
<type>: <short description>

<optional detailed explanation>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Adding/updating tests
- `refactor`: Code refactoring
- `chore`: Maintenance tasks

### Good Commit Messages

✅ **Do this:**
```bash
git commit -m "feat: add updateFields core implementation"
git commit -m "test: add VEVENT/VTODO/VCARD test fixtures"
git commit -m "fix: preserve unmodified fields during update"
git commit -m "docs: add usage examples to README"
git commit -m "refactor: simplify ical.js component parsing"
```

❌ **Not this:**
```bash
git commit -m "updates"
git commit -m "fix stuff"
git commit -m "work in progress"
git commit -m "more changes"
```

### When to Commit

**Commit after:**
- Completing a logical unit (single function)
- Adding tests for a feature
- Fixing a bug
- Updating documentation
- Refactoring a module

**Commit frequency:**
- Small, focused commits (every 30-60 minutes of work)
- Each commit should be functional (tests pass)
- Before switching contexts or taking breaks

**Push frequency:**
```bash
# Push after every 2-3 commits
git push origin feature/branch-name

# Or at natural stopping points
# - End of work session
# - Before asking for review
# - After completing a feature
```

---

## GitHub Issues

### Creating Issues

Use `gh` CLI to create issues for:
- Future enhancements
- Known limitations
- Bugs discovered during development
- Documentation improvements

**Examples:**
```bash
# Future enhancement
gh issue create \
  --title "Add multi-value property support (ATTENDEE)" \
  --body "Currently updateFields() only handles single-value properties. Need to support arrays for ATTENDEE, CATEGORIES, etc." \
  --label "enhancement,future"

# Known limitation
gh issue create \
  --title "Add structured property support (VCARD.N)" \
  --body "VCARD.N has 5 subcomponents (Family;Given;Additional;Prefix;Suffix). Need special handling or clear documentation of current limitation." \
  --label "enhancement,future"

# Bug report
gh issue create \
  --title "Properties lost after updateFields()" \
  --body "DTSTART disappears when updating SUMMARY on some VEVENT objects. Need to investigate ical.js component handling." \
  --label "bug,priority-high"

# Documentation
gh issue create \
  --title "Add timezone handling guide to README" \
  --body "Users need clear guidance on how to handle timezones since library doesn't convert automatically." \
  --label "documentation"
```

### Managing Issues
```bash
# List all issues
gh issue list

# List by label
gh issue list --label "bug"
gh issue list --label "enhancement"

# View issue details
gh issue view 1

# Close issue
gh issue close 1 --comment "Fixed in commit abc123"

# Reopen issue
gh issue reopen 1
```

### Issue Labels

Use consistent labels:
- `bug` - Something isn't working
- `enhancement` - New feature or request
- `documentation` - Documentation improvements
- `future` - Planned for later version
- `priority-high` - Needs immediate attention
- `priority-low` - Nice to have
- `wontfix` - Out of scope

---

## Pull Request Workflow

### Creating a Pull Request
```bash
# Ensure all changes committed and pushed
git status  # Should be clean
npm test    # Should pass
git push origin feature/branch-name

# Create PR with gh CLI
gh pr create \
  --title "Implement core updateFields functionality" \
  --body "
## Changes
- Add updateFields() for VEVENT/VTODO/VCARD
- Implement field-agnostic property updates
- Add comprehensive test suite
- Add README with usage examples

## Testing
- [x] All tests pass
- [x] Tested with real tsdav integration
- [x] README example verified
- [x] Works with all three component types (VEVENT/VTODO/VCARD)

## Known Limitations (tracked in issues)
- Multi-value properties (#1)
- Structured properties (#2)
- Timezone handling (#3)

## Breaking Changes
None - initial implementation
" \
  --base main \
  --label "enhancement"
```

### PR Review Process
```bash
# List open PRs
gh pr list

# View PR details
gh pr view 1

# Check PR status
gh pr status

# Review PR (if reviewing your own work)
gh pr review 1 --approve

# Merge PR
gh pr merge 1 --squash --delete-branch

# Or merge and keep branch
gh pr merge 1 --squash
```

### PR Best Practices

**Before creating PR:**
- [ ] All tests pass (`npm test`)
- [ ] Code is linted/formatted
- [ ] README updated if needed
- [ ] CHANGELOG updated (if exists)
- [ ] No merge conflicts with base branch

**PR description should include:**
- Summary of changes
- Testing checklist
- Related issues (closes #X)
- Breaking changes (if any)
- Screenshots/examples (if UI/API changes)

---

## Development Cycle

### Standard Workflow

**1. Start feature:**
```bash
git checkout main
git pull origin main
git checkout -b feature/new-feature
```

**2. Development:**
```bash
# Make changes
# ... edit files ...

# Commit frequently
git add .
git commit -m "feat: add X functionality"

# Push regularly (every 2-3 commits)
git push origin feature/new-feature
```

**3. Create issues for limitations:**
```bash
gh issue create --title "Future: Add Y support" --label "future"
```

**4. Complete feature:**
```bash
# Final commit
git add .
git commit -m "test: add comprehensive test coverage"
git push origin feature/new-feature

# Create PR
gh pr create --title "Add new feature" --base main
```

**5. Merge:**
```bash
# After review/approval
gh pr merge 1 --squash --delete-branch
```

**6. Cleanup:**
```bash
git checkout main
git pull origin main
git branch -d feature/new-feature  # Delete local branch
```

---

## Release Process

### Versioning

Follow Semantic Versioning (semver):
- **MAJOR** (1.0.0): Breaking changes
- **MINOR** (0.1.0): New features, backwards compatible
- **PATCH** (0.0.1): Bug fixes, backwards compatible

### Creating a Release
```bash
# Update version in package.json
npm version patch  # or minor, or major

# This creates a git tag automatically
# Push tag
git push origin v1.0.0

# Create GitHub release
gh release create v1.0.0 \
  --title "v1.0.0 - Initial Release" \
  --notes "
## Features
- Field-agnostic updateFields() for VEVENT/VTODO/VCARD
- Zero business logic, maximum flexibility
- Works with tsdav as peer dependency

## Installation
\`\`\`bash
npm install tsdav-utils
\`\`\`

## Documentation
See README for usage examples

## Known Limitations
- Multi-value properties (issue #1)
- Structured properties (issue #2)
- Timezone handling (issue #3)
"

# Publish to npm
npm publish
```

### Release Checklist

Before releasing:
- [ ] All tests pass
- [ ] README is up to date
- [ ] CHANGELOG updated
- [ ] Version bumped in package.json
- [ ] No open critical bugs
- [ ] Documentation complete
- [ ] Examples work

---

## Git Best Practices

### Do's ✅

- **Commit frequently** with clear messages
- **Push regularly** (don't keep changes local for days)
- **Create issues proactively** (document limitations/future work)
- **Use branches** for all work (never commit to main)
- **Write descriptive commit messages** (future you will thank you)
- **Test before committing** (ensure code works)
- **Pull before push** (avoid conflicts)
- **Use PR descriptions** (explain what and why)

### Don'ts ❌

- **Never commit directly to main** (always use PR)
- **Never force push** to main or shared branches
- **Never commit secrets** (API keys, passwords, tokens)
- **Never commit large binary files** (unless necessary)
- **Never use vague commit messages** ("fix", "update", "wip")
- **Never leave broken code** in commits
- **Never forget git identity** (always verify before first commit)

---

## Troubleshooting

### Wrong Git Identity
```bash
# If you committed with wrong identity
git commit --amend --author="Philipp <your-email@example.com>"
git push --force-with-lease origin branch-name
```

### Undo Last Commit
```bash
# Keep changes, undo commit
git reset --soft HEAD~1

# Discard changes, undo commit
git reset --hard HEAD~1
```

### Fix Commit Message
```bash
# Last commit only
git commit --amend -m "new message"
git push --force-with-lease origin branch-name
```

### Resolve Merge Conflicts
```bash
# Update your branch with main
git checkout feature/branch
git pull origin main

# Fix conflicts in editor
# Then:
git add .
git commit -m "fix: resolve merge conflicts with main"
git push origin feature/branch
```

### Accidentally Committed to Main
```bash
# Create branch from current state
git branch feature/emergency-save

# Reset main to remote
git checkout main
git reset --hard origin/main

# Continue work on new branch
git checkout feature/emergency-save
```

---

## GitHub Configuration

### Branch Protection (Recommended)
```bash
# Protect main branch (prevents direct commits)
gh api repos/OWNER/tsdav-utils/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["test"]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews=null \
  --field restrictions=null
```

### Automatic Labeling

Create `.github/labeler.yml`:
```yaml
documentation:
  - '**/*.md'
  - 'docs/**/*'

tests:
  - 'test/**/*'
  - '**/*.test.ts'

source:
  - 'src/**/*'
```

---

## Summary

### Quick Reference
```bash
# Start work
git checkout -b feature/name

# During development
git add .
git commit -m "type: description"
git push origin feature/name

# Create issues
gh issue create --title "..." --label "enhancement"

# Finish work
gh pr create --title "..." --base main
gh pr merge 1 --squash --delete-branch

# Release
npm version patch
git push origin v1.0.0
gh release create v1.0.0
npm publish
```

### Remember

1. **Always verify git identity** before first commit
2. **Commit frequently** (small, focused changes)
3. **Push regularly** (don't hoard changes)
4. **Create issues** for future work
5. **Use PRs** for all merges to main
6. **Test before committing** (broken commits are bad)

---

**Questions or issues with Git workflow?** Create an issue with label `meta` or `question`.
