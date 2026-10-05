# Isolated R4 Docker review

Test-only branch, no application or deployment. Push trigger is restricted to
`codex/r4-docker-review-20261006`; GitHub-hosted Linux/amd64, contents:read,
no environments, production secrets, SSH, registry publication or server access.

Python files are byte-for-byte copies from reviewed R4 archive SHA-256
`e09729bca4636de287f5aa08d4b51ddc9b8e18d6870bc912bb7cdedcc86aaa0e`.
`SHA256SUMS` enumerates all 16 necessary Python files. Baseline R2 is used only
by the existing regression that characterizes the old lock defect.
No real settings, runtime.env, dumps or archive history are included.

The unchanged `python tests/run_checks.py --docker` runs the prior simulations,
Linux flock tests and three actual Docker scenarios. The fixture uses synthetic
HTTP containers, not the Incident Management application or MAX. It refuses
any preexisting container, builds local synthetic images from python:3.12-slim,
and removes only its own objects. The workflow may pull that base image.

Workflow-only CLI tracing records the real Docker commands and their exact
stdout/stderr/exit status, without changing the reviewed tests or responses.
Artifacts include logs on failure, environment versions, source checksums and
before/after inventories. A passing mock test is not a passing Docker scenario.
