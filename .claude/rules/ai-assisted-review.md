# AI-assisted code generation and review

This experiment applies to all agent providers and AI-assisted contributions. It does not authorize commits, pushes, PR creation, or GitHub comments; follow the existing repository permissions.

## Attribution

- Record every model that generated or substantially revised code in the PR description, including provider and exact model/version when available. A tool name alone (for example, Claude Code or Codex) is insufficient. Never guess a model identity; explicitly mark unavailable details as unknown.
- Record AI review models, the reviewed commit or diff scope, the outcome, and how actionable findings were handled. Say explicitly when AI was not used or a review has not been completed.

## Independent review

1. Before AI code review, identify the generation models from the PR description or session history. Select a model different from every generation model. A new session, different tool/provider wrapper, or different reasoning setting on the same model does not qualify.
2. Before pushing your own AI-assisted feature branch and opening its PR, obtain that independent review of the complete diff against the intended base, including staged and unstaged changes. For maintainers, this is a review checkpoint within the existing landing workflow; it does not permit pushing feature branches.
3. Give the reviewer the requirements, applicable repository guidance, diff, relevant surrounding code, and validation evidence. Include the prompt below in every review request, including delegated reviews.
4. Evaluate findings on their evidence, fix actionable issues within scope, and run focused validation. Have substantive fixes reviewed again. If the review model generates fixes, record it as a generation model too and select a different model for the next review.
5. If generation identity or a suitable review model is unavailable, report the limitation. Preliminary analysis may still help, but do not claim the independent review is complete or proceed past a required review checkpoint without it.

## Required review prompt

> Review this change independently and critically. Do not be sycophantic: do not flatter the author, agree by default, or assume the implementation is correct. Challenge assumptions and look for correctness, security, regression, and test-coverage problems. Report actionable findings with file/line references, concrete failure scenarios, and supporting evidence. Distinguish blockers from optional improvements, state uncertainty and validation gaps, and do not invent issues to fill a quota. If no actionable issues are found, say so plainly.

Use the same directives in branch reviews, PR reviews, and any sub-agent prompts. For AI review of someone else's PR, check its model attribution before selecting the reviewer; missing attribution means independence is unverified, not evidence that AI was unused.

CLI tools such as `gh` remain the default for fetching PRs and review comments. Claude's GitHub connector is an optional alternative when available; use of a connector does not change the model-independence or posting-permission requirements. Apply review recommendations only within the authorized task scope and validate the changes.
