from app import app
from database import db, User
from werkzeug.security import generate_password_hash

with app.app_context():
    admin = User(
        username="monarch",
        email="admin@example.com",
        password=generate_password_hash("YourStrongPassword"),
        is_admin=True
    )

    db.session.add(admin)
    db.session.commit()

    print("Admin created.")
    