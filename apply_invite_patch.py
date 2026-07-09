from pathlib import Path
path = Path('main.py')
text = path.read_text()
old = """    if not username or not email or not password:\n        return jsonify({'success': False, 'message': 'Username, email, and password are required'}), 400\n\n    if User.query.filter_by(username=username).first():\n        return jsonify({'success': False, 'message': 'Username already exists'}), 400\n    if User.query.filter_by(email=email).first():\n        return jsonify({'success': False, 'message': 'Email already registered'}), 400\n\n    app_entry = None\n    if code:\n        app_entry = WaitingList.query.filter_by(invitation_code=code, status='approved').first()\n        if app_entry and app_entry.expires_at and app_entry.expires_at < _now():\n            app_entry.status = 'expired'\n            db.session.commit()\n            app_entry = None\n"""
new = """    if not code:\n        return jsonify({'success': False, 'message': 'Invitation code is required'}), 400\n    if not username or not email or not password:\n        return jsonify({'success': False, 'message': 'Username, email, and password are required'}), 400\n\n    app_entry = WaitingList.query.filter_by(invitation_code=code, status='approved').first()\n    if not app_entry:\n        return jsonify({'success': False, 'message': 'Invalid or expired invitation code'}), 400\n    if app_entry.expires_at and app_entry.expires_at < _now():\n        app_entry.status = 'expired'\n        db.session.commit()\n        return jsonify({'success': False, 'message': 'Invitation code has expired'}), 400\n    if app_entry.email.lower() != email.lower():\n        return jsonify({'success': False, 'message': 'Email must match the approved application email'}), 400\n\n    if User.query.filter_by(username=username).first():\n        return jsonify({'success': False, 'message': 'Username already exists'}), 400\n    if User.query.filter_by(email=email).first():\n        return jsonify({'success': False, 'message': 'Email already registered'}), 400\n"""
old2 = """    user = User(\n        username=username,\n        email=email,\n        password_hash=hashed.decode('utf-8'),\n        is_approved=True,\n        created_at=_now(),\n        invitation_code=code if app_entry else None,\n        invitation_expires_at=app_entry.expires_at if app_entry else None\n    )\n"""
new2 = """    user = User(\n        username=username,\n        email=email,\n        password_hash=hashed.decode('utf-8'),\n        is_approved=True,\n        created_at=_now(),\n        invitation_code=code,\n        invitation_expires_at=app_entry.expires_at\n    )\n"""
if old not in text:
    raise SystemExit('old text not found')
text = text.replace(old, new)
if old2 not in text:
    raise SystemExit('old2 text not found')
text = text.replace(old2, new2)
path.write_text(text)
print('patched')
