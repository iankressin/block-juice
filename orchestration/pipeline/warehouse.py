import os

import psycopg2


def connect():
    """A connection to the warehouse, from the WAREHOUSE_* settings that dbt and ingestion also read."""
    return psycopg2.connect(
        host=os.environ["WAREHOUSE_HOST"],
        port=os.environ["WAREHOUSE_PORT"],
        user=os.environ["WAREHOUSE_USER"],
        password=os.environ["WAREHOUSE_PASSWORD"],
        dbname=os.environ["WAREHOUSE_DB"],
    )
