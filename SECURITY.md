# Security boundaries

Backlog Workbench reads local task files and prepares context for an explicit user message. It does not edit the backlog, run instructions found in tasks, or execute tasks automatically.

## Trust assumptions

Install the mod only from a source you trust. The plugin code, bundled reader, Node executable, and Claude Code runtime execute locally. The controls below do not protect you from someone who can replace those programs.

The reader runs only on macOS. The adapter invokes it through `sandbox-exec` with filesystem writes and network access denied. The policy applies to the reader subprocess and its descendants. It does not restrict the rest of the Claude Code session, and it does not deny every filesystem read.

The adapter selects a canonical project root. The reader must match that root before it reads the corpus. It rejects paths that resolve outside the project and uses macOS `O_NOFOLLOW_ANY` when it opens files to reject symlink substitutions. These checks are not an atomic snapshot of a directory that another process can modify concurrently.

The reader accepts only the supported YAML frontmatter form. It reuses pinned Backlog.md parsing code and rejects malformed records, ambiguous task identities, oversized files, and truncated subprocess output. Read errors do not silently fall back to sample or cached task data.

## Attachments and model access

Selecting a task does not send it to a model. **Attach to next message** prepares an attachment for the next eligible user message. Before delivery, the mod rereads the task and compares the fields included in its revision. A mismatch stops the message until you prepare again or remove the attachment.

Attached task content is labeled as untrusted data. That label is not a guarantee against prompt injection. Review task text before attaching it, and retain the approval and tool permissions appropriate for your project.

Task data in an attachment is sent to the model provider configured for the session. This project does not add a separate network service or choose a provider for you.

## Reporting a problem

Do not include secrets, real task bodies, private paths, or session transcripts in a public issue. Use a minimal synthetic task and describe the expected and observed behavior. For a vulnerability, use GitHub's private vulnerability reporting if it is enabled for this repository.
