# Security policy

OwnRabbit processes source code and holds GitHub App credentials, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/imtiyazakiwat/ownrabbit/security/advisories/new)

Include what you found, steps to reproduce, and the impact you believe it has. We aim to acknowledge reports within 3 business days.

## In scope

- Webhook signature bypass or job forgery against the worker
- Prompt injection that causes OwnRabbit to leak secrets, act outside the PR, or post attacker-controlled content as trusted
- Path traversal or command execution through the repository checkout tools
- Dashboard authorization flaws (changing settings of a repo you don't administer)
- Token or credential exposure

## Out of scope

- Findings quality (false positives or negatives): please open a regular issue
- Vulnerabilities in third-party LLM providers
