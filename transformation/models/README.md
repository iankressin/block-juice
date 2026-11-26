# Models

## Overview

The dbt models, in three layers. Staging reads each raw table, intermediate holds joins and rules per chain and protocol version, and marts hold the tables that questions read. They build in the `analytics` schema (`DBT_SCHEMA`).

## Subdirectories & Boundaries

- staging: [./staging/README.md](./staging/README.md) - One view per raw table and kind of record, `stg_<name>__<table>`. No joins and no rules.
- intermediate: [./intermediate/README.md](./intermediate/README.md) - Joins and rules, one folder per pipeline, one model per chain or protocol version.
- marts: [./marts/README.md](./marts/README.md) - One folder per pipeline, unioning the intermediate models into the tables questions read.
