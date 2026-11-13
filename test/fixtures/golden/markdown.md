**plutus-scan** · 2026-07-31 to 2026-10-28 (90 days)

Last 30 days: $19,404 ($19,404 cloud, $0.00 AI), +13% vs the previous 30. Biggest mover: AWS Amazon Elastic Compute Cloud / BoxUsage:m7g.large +$1,238. Projected October total: $20,143.

**Top drivers** (last 30 days against the previous 30)

| Service | Usage type | Previous | Current | Change |
| --- | --- | ---: | ---: | ---: |
| AWS Amazon Elastic Compute Cloud | USE1-BoxUsage:m7g.large | $7,068 | $8,306 | +$1,238 |
| Azure Virtual Machines | D4s v5 usage | $4,241 | $4,673 | +$432 |
| Azure Azure SQL Database | Gen Purpose compute | $2,120 | $2,336 | +$216 |
| AWS Amazon Simple Storage Service | USE1-TimedStorage-ByteHrs | $1,409 | $1,558 | +$149 |
| AWS EC2 - Other | USE1-NatGateway-Bytes | $1,237 | $1,363 | +$126 |

**Anomalies**

- 2026-10-13 AWS Amazon Elastic Compute Cloud: $778 against a baseline of $245 (+$532, high).

**Candidates to review** (places to look, not proven findings)

Possible savings: up to $584 in 30 days if it is waste. The bill cannot say.

*Often worth changing*

- gp2 volumes: $584 in 30 days. gp3 is usually about 20% cheaper. [If this is waste, Plutus can open the pull request that fixes it.](https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=md&utm_content=gp2)

*Worth a look*

- S3 Standard storage: $1,558 in 30 days. Data that is rarely read can sit in a cheaper class
- NAT gateway: $779 in 30 days. Often traffic that could use VPC endpoints

<sub>FOCUS: BilledCost, including credit and tax rows when present.<br>Last complete day: 2026-10-28. Currency: USD.</sub>

[This is a snapshot. Plutus tracks it daily, per team and per customer, with alerts.](https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=report)
