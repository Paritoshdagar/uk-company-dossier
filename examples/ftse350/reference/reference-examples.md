# Evidence-linked reference examples

Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.

Generated at: 2026-06-21T20:10:05.257Z

These examples show a few representative records for each Companies House data type used by the demo. They are deliberately compact reference examples for readers, not full dossiers or raw API payload dumps.

## charges

| Company number | Company         | Example fields                                                                                                                                                           | Companies House source                                                                   | Note                                               |
| -------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 00445790       | TESCO PLC       | classificationType: charge-description<br>createdOn: 2009-11-04<br>deliveredOn: 2009-11-06<br>personsEntitledCount: 1<br>status: outstanding                             | https://api.company-information.service.gov.uk/company/00445790/charges?items_per_page=3 |                                                    |
| 01470151       | BAE SYSTEMS PLC | chargeCode: 014701510051<br>classificationType: charge-description<br>createdOn: 2022-10-26<br>deliveredOn: 2022-11-04<br>personsEntitledCount: 1<br>status: outstanding | https://api.company-information.service.gov.uk/company/01470151/charges?items_per_page=3 |                                                    |
| 00023307       | DIAGEO PLC      | availability: complete<br>sampledItems: 0<br>statusCode: 200<br>totalResults: 0                                                                                          | https://api.company-information.service.gov.uk/company/00023307/charges?items_per_page=3 | No charge items were returned in the sampled page. |

## filings

| Company number | Company         | Example fields                                                                                                                                                        | Companies House source                                                                          | Note |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---- |
| 00445790       | TESCO PLC       | category: capital<br>date: 2026-06-10<br>description: capital-cancellation-shares<br>paperFiled: true<br>transactionId: MzUyNDY1MTExNmFkaXF6a2N4<br>type: SH06        | https://api.company-information.service.gov.uk/company/00445790/filing-history?items_per_page=3 |      |
| 01470151       | BAE SYSTEMS PLC | category: capital<br>date: 2026-06-17<br>description: capital-return-purchase-own-shares<br>paperFiled: true<br>transactionId: MzUyNTkyOTY5NWFkaXF6a2N4<br>type: SH03 | https://api.company-information.service.gov.uk/company/01470151/filing-history?items_per_page=3 |      |
| 00023307       | DIAGEO PLC      | category: miscellaneous<br>date: 2026-05-27<br>description: legacy<br>transactionId: MzUyMzAyOTQwOWFkaXF6a2N4<br>type: RP01SH01                                       | https://api.company-information.service.gov.uk/company/00023307/filing-history?items_per_page=3 |      |

## insolvency

| Company number | Company         | Example fields                                                 | Companies House source                                                     | Note                                                                                                                        |
| -------------- | --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 00445790       | TESCO PLC       | availability: not_available<br>caseCount: 0<br>statusCode: 404 | https://api.company-information.service.gov.uk/company/00445790/insolvency | The insolvency endpoint returned 404 at generation time, so this is an availability example rather than an insolvency case. |
| 01470151       | BAE SYSTEMS PLC | availability: not_available<br>caseCount: 0<br>statusCode: 404 | https://api.company-information.service.gov.uk/company/01470151/insolvency | The insolvency endpoint returned 404 at generation time, so this is an availability example rather than an insolvency case. |
| 00023307       | DIAGEO PLC      | availability: not_available<br>caseCount: 0<br>statusCode: 404 | https://api.company-information.service.gov.uk/company/00023307/insolvency | The insolvency endpoint returned 404 at generation time, so this is an availability example rather than an insolvency case. |

## officers

| Company number | Company         | Example fields                                                                     | Companies House source                                                                    | Note                                                            |
| -------------- | --------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 00445790       | TESCO PLC       | appointedOn: 2025-04-14<br>name: TAYLOR, Christopher Jon<br>officerRole: secretary | https://api.company-information.service.gov.uk/company/00445790/officers?items_per_page=3 | Officer names and appointments are public-register information. |
| 01470151       | BAE SYSTEMS PLC | appointedOn: 2024-05-09<br>name: CLARKE, Anthony<br>officerRole: secretary         | https://api.company-information.service.gov.uk/company/01470151/officers?items_per_page=3 | Officer names and appointments are public-register information. |
| 00023307       | DIAGEO PLC      | appointedOn: 2025-07-01<br>name: INGBER, Randall David<br>officerRole: secretary   | https://api.company-information.service.gov.uk/company/00023307/officers?items_per_page=3 | Officer names and appointments are public-register information. |

## profile

| Company number | Company         | Example fields                                                                                                                                             | Companies House source                                          | Note |
| -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- |
| 00445790       | TESCO PLC       | companyName: TESCO PLC<br>companyNumber: 00445790<br>companyStatus: active<br>dateOfCreation: 1947-11-27<br>jurisdiction: england-wales<br>type: plc       | https://api.company-information.service.gov.uk/company/00445790 |      |
| 01470151       | BAE SYSTEMS PLC | companyName: BAE SYSTEMS PLC<br>companyNumber: 01470151<br>companyStatus: active<br>dateOfCreation: 1979-12-31<br>jurisdiction: england-wales<br>type: plc | https://api.company-information.service.gov.uk/company/01470151 |      |
| 00023307       | DIAGEO PLC      | companyName: DIAGEO PLC<br>companyNumber: 00023307<br>companyStatus: active<br>dateOfCreation: 1886-10-21<br>jurisdiction: england-wales<br>type: plc      | https://api.company-information.service.gov.uk/company/00023307 |      |

## pscs

| Company number | Company         | Example fields                                                                  | Companies House source                                                                                            | Note                                                                                                                |
| -------------- | --------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 00445790       | TESCO PLC       | availability: complete<br>sampledItems: 0<br>statusCode: 200<br>totalResults: 0 | https://api.company-information.service.gov.uk/company/00445790/persons-with-significant-control?items_per_page=3 | No PSC items were returned in the sampled page. Large listed PLCs commonly report no current PSCs on this endpoint. |
| 01470151       | BAE SYSTEMS PLC | availability: complete<br>sampledItems: 0<br>statusCode: 200<br>totalResults: 0 | https://api.company-information.service.gov.uk/company/01470151/persons-with-significant-control?items_per_page=3 | No PSC items were returned in the sampled page. Large listed PLCs commonly report no current PSCs on this endpoint. |
| 00023307       | DIAGEO PLC      | availability: complete<br>sampledItems: 0<br>statusCode: 200<br>totalResults: 0 | https://api.company-information.service.gov.uk/company/00023307/persons-with-significant-control?items_per_page=3 | No PSC items were returned in the sampled page. Large listed PLCs commonly report no current PSCs on this endpoint. |
