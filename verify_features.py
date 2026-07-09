from main import app, db, WaitingList

app.config.update(TESTING=True)
with app.test_client() as client:
    resp = client.post('/api/register', data={
        'username': 'tester2',
        'email': 'tester2@example.com',
        'password': 'Password123!',
        'invitation_code': 'BAD-CODE'
    }, follow_redirects=False)
    print('invalid_code', resp.status_code, resp.get_json())

    app_entry = WaitingList(name='Runtime', email='runtime@example.com', status='approved', invitation_code='INV-RUNTIME')
    db.session.add(app_entry)
    db.session.commit()
    resp2 = client.get('/api/application-status?application_id=' + str(app_entry.id))
    print('status_lookup', resp2.status_code, resp2.get_json())
