# Security policy

`plutus-scan` runs on your machine with your own cloud and AI provider credentials. It reads
billing data and writes reports to local files. The README lists every host it calls and every
command it runs. A report that it does something else is a security report, and we want to hear it.

## Reporting a vulnerability

Email **security@plutus-cloud.com**, or use
[private vulnerability reporting](https://github.com/plutus-cloud/plutus-scan/security/advisories/new)
on this repository, which is visible only to maintainers until published.

Please do not open a public issue for a suspected vulnerability.

Include the version (`plutus-scan --version`), your Node version and operating system, what you
ran, what you saw and what you expected.

## What counts

- A credential written to disk, a log or any output.
- A request to a host, or an `aws` or `gh` command, that the README does not list.
- An HTML report that loads anything from the network or runs script from report data.
- A crafted FOCUS file that makes the tool read or write outside the paths it was given.

## What to expect

| | |
|---|---|
| Acknowledgement | within 3 business days |
| Initial assessment | within 10 business days |
| Fix for anything that exposes a credential or billing data | as fast as we can ship a release |
| Everything else | prioritised honestly, with a date in the reply |

## Supported versions

Fixes go into the latest release on npm. There are no maintained older branches.
