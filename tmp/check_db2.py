import sqlite3
conn = sqlite3.connect('C:/Users/OLAJUWON/OneDrive/Desktop/MonarchApp/instance/monarch.db')
cur = conn.cursor()
cur.execute('SELECT id, username, email, is_admin, balance, referral_code, referred_by, referral_earnings FROM user')
rows = cur.fetchall()
for r in rows:
    print(f"ID: {r[0]}, User: {r[1]}, Email: {r[2]}, Admin: {r[3]}, Bal: {r[4]}, Code: {r[5]}, RefBy: {r[6]}, RefEarn: {r[7]}")
conn.close()
