from pathlib import Path
p = Path('main.py')
text = p.read_text(encoding='utf-8', errors='replace')
start_marker = '\ndef api_register():'
start = text.find(start_marker)
if start == -1:
    raise SystemExit('api_register start not found')
# find next route decorator after this function
next_route = '\n\n@app.route('/register''
end = text.find(next_route, start)
if end == -1:
    # fallback: find "@app.route('/login'"
    end = text.find("\n\n@app.route('/login'", start)
if end == -1:
    raise SystemExit('api_register end not found')
old_block = text[start:end]
new_block = '''
@app.route('/api/register', methods=['POST'])
def api_register():
    data = request.form if request.form else request.get_json(silent=True) or {}
    code = str(data.get('invitation_code', '') or data.get('code', '') or '').strip()
    username = str(data.get('username', '') or '').strip()
    email = str(data.get('email', '') or '').strip()
    password = str(data.get('password', '') or '')
    referral_code = str(data.get('referral_code', '') or '').strip()

    if not code:
        return jsonify({'success': False, 'message': 'Invitation code is required'}), 400
    if not username or not email or not password:
        return jsonify({'success': False, 'message': 'Username, email, and password are required'}), 400

    app_entry = WaitingList.query.filter_by(invitation_code=code, status='approved').first()
    if not app_entry:
        return jsonify({'success': False, 'message': 'Invalid or expired invitation code'}), 400
    if app_entry.expires_at and app_entry.expires_at < _now():
        app_entry.status = 'expired'
        db.session.commit()
        return jsonify({'success': False, 'message': 'Invitation code has expired'}), 400
    if app_entry.email.lower() != email.lower():
        return jsonify({'success': False, 'message': 'Email must match the approved application email'}), 400

    # Check existing users by email/username
    user_by_email = User.query.filter_by(email=email).first()
    user_by_username = User.query.filter_by(username=username).first()

    # If there's an existing account with this email
    if user_by_email:
        existing_hash = (user_by_email.password_hash or '').strip()
        if existing_hash:
            return jsonify({'success': False, 'message': 'Email already registered'}), 400
        # ensure username not taken by someone else
        if user_by_username and user_by_username.id != user_by_email.id:
            return jsonify({'success': False, 'message': 'Username already exists'}), 400
        # finalize account: set username (if changed), set password, approve
        user_by_email.username = username
        user_by_email.password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        user_by_email.is_approved = True
        user_by_email.invitation_code = code
        user_by_email.invitation_expires_at = app_entry.expires_at
        db.session.commit()
        trigger_mentor_milestone(user_by_email, 'welcome')
        return jsonify({'success': True, 'message': 'Account completed. You can now log in.', 'redirect': url_for('login')})

    # If username exists (no email match)
    if user_by_username:
        existing_hash = (user_by_username.password_hash or '').strip()
        if existing_hash:
            return jsonify({'success': False, 'message': 'Username already exists'}), 400
        # ensure email matches the pending account
        if user_by_username.email.lower() != email.lower():
            return jsonify({'success': False, 'message': 'Username exists with a different email'}), 400
        user_by_username.password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        user_by_username.is_approved = True
        user_by_username.invitation_code = code
        user_by_username.invitation_expires_at = app_entry.expires_at
        db.session.commit()
        trigger_mentor_milestone(user_by_username, 'welcome')
        return jsonify({'success': True, 'message': 'Account completed. You can now log in.', 'redirect': url_for('login')})

    # Otherwise create a new approved user (matching approved application)
    hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
    user = User(
        username=username,
        email=email,
        password_hash=hashed.decode('utf-8'),
        is_approved=True,
        created_at=_now(),
        invitation_code=code,
        invitation_expires_at=app_entry.expires_at
    )

    if referral_code:
        referrer = User.query.filter_by(referral_code=referral_code).first()
        if referrer and referrer.username != username:
            user.referred_by = referrer.id

    default_mentor = Mentor.query.first()
    if default_mentor:
        user.mentor_id = default_mentor.id

    db.session.add(user)
    db.session.commit()
    trigger_mentor_milestone(user, 'welcome')
    return jsonify({'success': True, 'message': 'Registration successful', 'redirect': url_for('login')})
'''
new_text = text[:start] + new_block + text[end:]
# backup
p.with_suffix('.bak').write_text(text, encoding='utf-8')
p.write_text(new_text, encoding='utf-8')
print('api_register updated; backup at main.py.bak')
