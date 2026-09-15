#!/bin/sh
# Restarts the feedback service after a deploy changed its code.
#
# Installed to /usr/local/sbin/readquran-restart-feedback, owned by root, and
# allowed to the deploy user by one sudoers line. No arguments on purpose.

set -e
systemctl restart readquran-feedback
echo "feedback service restarted"
