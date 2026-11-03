# North South Academy

> **An offline-first management application designed to keep an academy running across devices without making every action depend on a server.**

North South Academy manages members, monthly fees, payments, products and snack-bar sales. What began as an operational tool became a more interesting engineering problem when I needed the same information to work on desktop, mobile and Android, including when a device temporarily loses connectivity.

## How It's Made

**Tech used:** Vanilla JavaScript, HTML, CSS, Vite, LocalStorage, Google Drive API, OAuth, Capacitor, Node.js

I built the interface without a frontend framework and packaged the same web application as a PWA and an Android app using Capacitor. Business rules such as fee history, payment allocation across months, validation and reporting are kept in separate JavaScript modules.

Changes are saved locally before the interface updates. Google authentication identifies the user, while Google Drive's private application-data area provides synchronization between that user's devices. The application can continue operating from local data when Drive is unavailable.

## Engineering Approach

The main challenge was concurrent editing. A single shared JSON snapshot can cause one device to overwrite changes made on another, so I introduced an operation journal: each local change has its own identifier and is synchronized as an independent record.

Operations can be merged and replayed, while deleted records retain tombstones so older copies do not accidentally restore them. A materialized snapshot remains useful for faster loading. The data model also separates payment history from fee rules, allowing payments to be allocated to the correct months.

## Optimizations

I added automated tests for merging, storage, authentication-related behavior, calculations and UI regressions. I also refined session recovery, mobile keyboard behavior and the Android build process, including repeatable icon, splash-screen and OAuth configuration steps.

The biggest lesson was that synchronization is primarily a data-consistency problem. Handling local writes, conflicts and recovery deliberately mattered more than simply connecting the application to cloud storage.
