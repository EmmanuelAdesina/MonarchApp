import os
from sqlalchemy import create_engine, inspect
from dotenv import load_dotenv

dotenv_path = r"c:\Users\OLAJUWON\OneDrive\Desktop\MonarchApp\.env"
load_dotenv(dotenv_path)

db_url = os.getenv("DATABASE_URL")
engine = create_engine(db_url)
inspector = inspect(engine)

tables = inspector.get_table_names()
print(f"Tables: {tables}")

for table in tables:
    if 'user' in table:
        print(f"Columns in '{table}':")
        for col in inspector.get_columns(table):
            print(f"  {col['name']}: {col['type']}")
