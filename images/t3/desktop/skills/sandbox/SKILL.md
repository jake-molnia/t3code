---
name: sandbox
description: Use the sandbox's shared browser, desktop, shell, code execution, files, and document conversion tools.
---

# Sandbox tools

Keep task files and outputs under `SANDBOX_ROOT`, which defaults to `/workspace`. Set the shell working directory explicitly and use absolute paths when sharing files between tools. AIO shell, Python and JavaScript execution, file operations, and document conversion run as the same sandbox user.

Playwright controls the Chromium already visible on the desktop. Use browser snapshots and element actions for web content. Use computer screenshots and input for native applications, browser chrome, and operating system dialogs. These tools share browser tabs, focus, and state. Read a fresh snapshot or screenshot when switching between them. Keep at least one Chromium window open because the runtime supervises the browser process for the entire sandbox session.

AIO forwards document conversion to MarkItDown. Use its converter for supported local files or URLs, then save any output needed by the task in the workspace. Read the available tool schemas for accepted arguments and supported operations; the harness exposes the tools granted to this task.

Verify changes through the page, desktop, command result, or resulting file before reporting success. A successful click only establishes that input was sent; inspect the resulting state to confirm its effect.
