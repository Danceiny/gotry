[English](extension-privacy.md) | [简体中文](extension-privacy.zh-CN.md)

# Stai Extension Privacy Policy

**Last updated: 2026-09-25**

Stai (formerly GoTry Session Bridge) supports authorized travel searches and supplier-portal sign-in. This policy describes the extension itself; the websites and GoTry backend have their own data handling.

## Data and destinations

- For supported Ctrip flight and hotel, 12306 rail, and Dida supplier-portal searches, the extension observes matching responses produced by those pages. It may pass response text, the page URL and title, and a challenge indicator to the active GoTry bridge.
- To check sign-in state, it selects the **names** of specific cookies. Chrome's cookies API returns cookie objects, but the extension does not include cookie values in bridge results or persist them.
- In desktop use, the bridge is the GoTry process on `127.0.0.1` ports 8791–8795. In the HotelByte employee portal flow, an authenticated portal supplies a short-lived join ticket and a bridge path on its own origin; search results and status are sent through that portal to its backend. **The backend flow can send search data off the device.** The extension has no analytics or advertising SDK.

## Supplier-portal sign-in

When the employee portal supplies an authorized one-time Dida login payload, the extension handles the username and password in memory, opens the allowlisted Dida login page, fills its form, and submits it. The supplier receives those credentials through its login form. The extension does not put the payload in persistent extension storage or its normal bridge result; it does not read or forward cookie values. Portal search may also operate page controls to start a search. These actions are distinct from booking or payment, which the extension does not perform.

## Limited use and contact

Stai uses information received through Chrome APIs only for the user-facing functions described here. Its use of that information adheres to the [Chrome Web Store User Data Policy, including Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use/). It does not sell data, use it for advertising, or permit human review except where the policy allows.

GoTry desktop session searches use GoTry's consent gate. The extension can be disabled in Chrome at any time. For questions, use https://github.com/Danceiny/gotry/issues.
