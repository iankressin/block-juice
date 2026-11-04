# ELT pipeline

Sources extract wallet balances and other chain data into the warehouse, dbt builds models from them, and Dagster schedules both.

## Language

### Ingestion

**Source**:
A package that reads one kind of data from one origin and fills one raw table.
_Avoid_: connector, extractor, job

**Call**:
One request a source makes for data, described well enough to make again in a later run.
_Avoid_: request, query

**Record**:
One row a call produced, keyed so that a rerun replaces it instead of adding another.
_Avoid_: row, item

**Batch**:
The records and failed calls that a source hands over together.
_Avoid_: chunk, page

**Run**:
One execution of one source, from picking up its retries to recording its outcome.
_Avoid_: job, execution

### Warehouse

**Warehouse**:
The database that holds the raw tables, the dead letters and the run log, and in which dbt builds its models.
_Avoid_: target, database, DB

**Raw table**:
The warehouse table one source fills, which dbt reads as a source.
_Avoid_: target table, landing table

**Dead letter**:
A failed call, kept in the warehouse so a later run can make it again.
_Avoid_: retry queue item, failed job

**Pending dead letter**:
A dead letter that the next run retries.

**Parked dead letter**:
A dead letter that no run retries, because it failed too many times or no longer matches what its source accepts as a call. It waits for a person.
_Avoid_: dropped, abandoned

**Run log**:
The warehouse's record of every run and its outcome.
_Avoid_: run history, audit log
