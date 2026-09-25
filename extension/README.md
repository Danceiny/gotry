[English](README.md) | [简体中文](README.zh-CN.md)

# Stai browser extension

Stai (formerly GoTry Session Bridge) connects supported travel-search pages to GoTry. The Chrome Web Store and unpacked builds have different extension IDs but use the same bridge contract.

## What it does

- Observes matching search responses on supported Ctrip flight/hotel, 12306 rail and Dida supplier-portal pages. It selects specified login-cookie **names**, not their values.
- Sends search results and status to the local GoTry bridge in desktop use. An authenticated HotelByte employee portal can instead provide a short-lived ticket for its backend bridge, in which case search data can leave the device.
- When that portal supplies authorized one-time Dida login credentials, the extension handles them in memory, opens the allowlisted login page, fills and submits the form. It can also operate Dida search controls. It does not persist credentials in extension storage or perform bookings or payments.

See the [privacy policy](https://github.com/Danceiny/gotry/blob/main/docs/ops/extension-privacy.md) for the current data and destination disclosure.

## Install

1. [Chrome Web Store](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd): one-click install and automatic store updates. Check the **version shown on the listing** before relying on Dida/HotelByte capabilities; the store can lag source and GitHub builds while an update is under review.
2. GitHub Releases: run `npx @danceiny/gotry setup --extension-from=github`, or download and verify the versioned `ext-*` release's `gotry-session-bridge.tar.gz`, then load the extracted directory from `chrome://extensions` with Developer mode enabled.
3. npm package fallback: run `npx @danceiny/gotry setup` and load `~/.gotry/extension` in `chrome://extensions`. The npm package may lag the source and GitHub extension release.

The store ID is `oeajpiccmonococjcegddlooeeohlbgd`; the unpacked ID is `olpgkofjhhiiiahdkkbcninhjmegghfe`. For desktop use, GoTry's local bridge listens on `127.0.0.1` ports 8791–8795.
