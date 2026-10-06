# Isolated R4 Docker review

Test-only branch, no application or deployment. Push trigger is restricted to
`codex/r4-docker-network-20261006`; GitHub-hosted Linux/amd64, contents:read,
no environments, production secrets, SSH, registry publication or server access.

Operational Python files in `revision-4` are byte-for-byte copies from reviewed R4 archive SHA-256
`e09729bca4636de287f5aa08d4b51ddc9b8e18d6870bc912bb7cdedcc86aaa0e`.
`SHA256SUMS` enumerates all 16 necessary Python files. Only the Docker fixture
has changed since `f37924bc2861587478e35a9659dd8798978694d4`: an owned bridge
replaces the sole internal network, with explicit loopback port publication,
actual port and HTTP checks before each scenario, and script-result logging.
All scenario bodies and R4 guards are unchanged. Baseline R2 is used only
by the existing regression that characterizes the old lock defect.
No real settings, runtime.env, dumps or archive history are included.

The unchanged `python tests/run_checks.py --docker` runs the prior simulations,
Linux flock tests and three actual Docker scenarios. The fixture uses synthetic
HTTP containers, not the Incident Management application or MAX. It refuses
any preexisting container, builds local synthetic images from python:3.12-slim,
and removes only its own objects. The workflow may pull that base image.

CLI tracing records the real Docker commands and their exact
stdout/stderr/exit status, without changing operational scripts or responses.
Artifacts include logs on failure, environment versions, source checksums and
before/after inventories. A passing mock test is not a passing Docker scenario.

The bridge is not an egress firewall. Isolation from production consists of an
ephemeral GitHub-hosted runner with synthetic fixtures, no production credentials,
server access, application or DB. The fixture only calls loopback HTTP; it does
not contact MAX or any server. The host publication must be exactly 127.0.0.1.
The reviewed cleanup removes only the fixture containers, tags and network;
the workflow checks that no fixture container/tag/network remains and volumes
are unchanged. The pulled base image and builder cache live only on the disposable
runner and are discarded with it; no broad prune is run.
