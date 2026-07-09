import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from main import app, db, User, WaitingList


def test_registration_requires_valid_invitation_code():
    app.config.update(TESTING=True)
    with app.test_client() as client:
        resp = client.post('/api/register', data={
            'username': 'tester',
            'email': 'tester@example.com',
            'password': 'Password123!',
            'invitation_code': 'BAD-CODE'
        }, follow_redirects=False)
        assert resp.status_code == 400


def test_application_status_lookup_by_email_and_id():
    app.config.update(TESTING=True)
    with app.test_client() as client:
        app_entry = WaitingList(name='Test', email='track@example.com', status='approved', invitation_code='INV-TEST')
        db.session.add(app_entry)
        db.session.commit()
        resp = client.get('/api/application-status?application_id=' + str(app_entry.id))
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['success'] is True
        assert data['application']['email'] == 'track@example.com'
