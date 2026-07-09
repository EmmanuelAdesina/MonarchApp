from pathlib import Path
path = Path("main.py")
text = path.read_text(encoding="utf-8", errors="replace")
old = """    if not username or not email or not password:
        return jsonify({'success': False, 'message': 'Username, email, and password are required'}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({'success': False, 'message': 'Username already exists'}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({'success': False, 'message': 'Email already registered'}), 400

    app_entry = None
    if code:
        app_entry = WaitingList.query.filter_by(invitation_code=code, status='approved').first()
        if app_entry and app_entry.expires_at and app_entry.expires_at < _now():
            app_entry.status = 'expired'
            db.session.commit()
            app_entry = None
"""
new = """    if not code:
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

    if User.query.filter_by(username=username).first():
        return jsonify({'success': False, 'message': 'Username already exists'}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({'success': False, 'message': 'Email already registered'}), 400
"""
old2 = """    user = User(
        username=username,
        email=email,
        password_hash=hashed.decode('utf-8'),
        is_approved=True,
        created_at=_now(),
        invitation_code=code if app_entry else None,
        invitation_expires_at=app_entry.expires_at if app_entry else None
    )
"""
new2 = """    user = User(
        username=username,
        email=email,
        password_hash=hashed.decode('utf-8'),
        is_approved=True,
        created_at=_now(),
        invitation_code=code,
        invitation_expires_at=app_entry.expires_at
    )
"""
if old not in text:
    raise SystemExit('old text not found in main.py')
text = text.replace(old, new)
if old2 not in text:
    raise SystemExit('old2 text not found in main.py')
text = text.replace(old2, new2)
path.write_text(text, encoding='utf-8')
print('main.py patched')
path = Path('templates/register.html')
text = path.read_text(encoding='utf-8', errors='replace')
old = """            <div>
                <label for=\"referral_code\" style=\"display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); margin-bottom: 0.5rem;\">
                    Referral Code <span style=\"color: var(--text-faint); font-weight: 400;\">(optional)</span>
                </label>
                <input type=\"text\" id=\"referral_code\" name=\"referral_code\" placeholder=\"e.g. X7K9M2P1\"
                    style=\"width: 100%; padding: 0.8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.95rem; outline: none; transition: border-color 0.3s; text-transform: uppercase;\"
                    onfocus=\"this.style.borderColor='var(--gold)'\" onblur=\"this.style.borderColor='var(--border)'\">
            </div>

            <input type=\"hidden\" id=\"invitation_code\" name=\"invitation_code\" value={{ code }}>
"""
new = """            <div>
                <label for=\"invitation_code\" style=\"display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); margin-bottom: 0.5rem;\">
                    Invitation Code <span style=\"color: var(--text-faint); font-weight: 400;\">(required)</span>
                </label>
                <input type=\"text\" id=\"invitation_code\" name=\"invitation_code\" required placeholder=\"Enter your invitation code\"
                    style=\"width: 100%; padding: 0.8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.95rem; outline: none; transition: border-color 0.3s; text-transform: uppercase;\"
                    onfocus=\"this.style.borderColor='var(--gold)'\" onblur=\"this.style.borderColor='var(--border)'\" value=\"{{ code }}\">
            </div>

            <div>
                <label for=\"referral_code\" style=\"display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); margin-bottom: 0.5rem;\">
                    Referral Code <span style=\"color: var(--text-faint); font-weight: 400;\">(optional)</span>
                </label>
                <input type=\"text\" id=\"referral_code\" name=\"referral_code\" placeholder=\"e.g. X7K9M2P1\"
                    style=\"width: 100%; padding: 0.8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.95rem; outline: none; transition: border-color 0.3s; text-transform: uppercase;\"
                    onfocus=\"this.style.borderColor='var(--gold)'\" onblur=\"this.style.borderColor='var(--border)'\">
            </div>
"""
if old not in text:
    raise SystemExit('register form block not found in register.html')
text = text.replace(old, new)
path.write_text(text, encoding='utf-8')
print('register.html patched')
