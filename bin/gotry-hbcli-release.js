/** Official stable hbcli baseline. npm's staicli@latest still points to 0.0.3. */
export const HBCLI_RELEASE_VERSION = '0.0.4'
export const HBCLI_INSTALL_URL = `https://github.com/hotelbyte-com/docs/releases/download/staicli-v${HBCLI_RELEASE_VERSION}/install.sh`
export const HBCLI_INSTALL_CMD = `curl -fsSL --connect-timeout 15 --max-time 60 ${HBCLI_INSTALL_URL} | bash -s -- --version ${HBCLI_RELEASE_VERSION}`
