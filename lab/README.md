# Disposable exact cache-ID lab

Run only in the fresh GitHub-hosted runner selected by this branch's workflow.
No production access, credentials, source images or cache IDs are used.
The nested Engine is 29.1.3 with containerd image storage; its own automatic
build GC is disabled so unrelated GC cannot invalidate before/after evidence.
No daemon settings on a real installation are changed by this lab.

All deletion tests use native `docker builder prune` with DOCKER_BUILDKIT=0
to disable CLI forwarding to Buildx, an anchored ID regular expression and
`shared=false`. This environment variable changes only CLI routing for the
one command: the Engine still handles its BuildKit cache.
Buildx bundled in the disposable image is used only to create synthetic cache.

Logs and before/after API snapshots are uploaded even after failure. Assertions
are explicit exceptions, so Python -O cannot remove checks. The runner is
discarded by GitHub, without any general prune command in this workflow.
