[English](extension-privacy.md) | [简体中文](extension-privacy.zh-CN.md)

# GoTry Session Bridge Privacy Policy

**Last updated: 2026-08-30**

GoTry Session Bridge ("the extension") is an optional local data bridge for the
GoTry travel assistant. This policy explains what the extension does and does
not do with data.

## Summary (English)

- The extension passively observes flight-search responses **that the page
  itself loads** on `flights.ctrip.com`, and reads only the **names** of login
  cookies to detect whether you are signed in.
- Cookie **values are never read, stored, or transmitted**. Login always
  happens on the airline/OTA website itself, performed by you.
- The only data destination is the GoTry process on **your own machine**
  (loopback `127.0.0.1`, ports 8791-8795). Nothing leaves your machine; there
  is no cloud, no analytics, no ads, no third-party SDK.
- The extension performs **zero writes** on any website: it does not send
  requests to, or modify content of, any page beyond observing responses the
  page itself produced.
- Every GoTry session search still requires your explicit in-session approval
  (GoTry's own consent gate), and the extension can be turned off at any time
  from its browser card, independently of this policy.

## Key Points (Chinese)

- The extension only **passively sniffs** flight-search responses that the
  `flights.ctrip.com` page itself emits; it reads only the **names** of login
  cookies to determine sign-in state.
- Cookie **values are never read, stored, or transmitted**; login is always
  completed by you in person on the Ctrip (携程) website.
- The only data destination is the GoTry process on **your own machine**
  (loopback `127.0.0.1`, ports 8791-8795); nothing goes to the cloud, and
  there is no analytics, no ads, and no third-party SDK.
- The extension performs **zero writes** on any website: it never sends
  requests on your behalf and never modifies page content.
- Every session search still requires your explicit in-session approval
  within GoTry (the gotry consent gate); the extension card can be switched
  off with one click at any time, independently of this policy.

## Contact

Issues: https://github.com/Danceiny/gotry/issues
