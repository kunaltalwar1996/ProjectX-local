import { supabase } from './lib/supabase.js';

const currentPath = window.location.pathname;
let currentPage = currentPath.split('/').pop() || 'index.html';
const isSharedFilterRoute = currentPath.includes('/shared-filter/') || currentPage === 'shared-filter';

if (isSharedFilterRoute) {
    currentPage = 'shared-filter.html';
} else if (!currentPage.includes('.')) {
    currentPage += '.html'; // Handle Vite-style paths without extensions
}

let appBasePath = currentPath.endsWith('/')
    ? currentPath
    : currentPath.slice(0, currentPath.lastIndexOf('/') + 1);

if (isSharedFilterRoute) {
    appBasePath = '/';
}

let userRole = localStorage.getItem('role');
let isLoginPage = currentPage === 'login.html' || currentPage === 'staff-login.html' || currentPage === 'signup.html';
let activeInquiryId = null;
let updateHeaderVisibility = null;
let referrerId = null;
let uploadedMedia = [];

// Parse ref parameter on boot
try {
    const urlParamsForRef = new URLSearchParams(window.location.search);
    const refParam = urlParamsForRef.get('ref');
    if (refParam) {
        referrerId = refParam;
        localStorage.setItem('referred_by', refParam);
    }
} catch (e) {
    console.error('Failed to parse ref query parameter:', e);
}

function toAppUrl(page) {
    if (page.startsWith('http')) return page;
    if (page.startsWith('/')) return `${appBasePath}${page.replace(/^\/+/, '')}`;
    return `${appBasePath}${page}`;
}

window.toAppUrl = toAppUrl;

function navigateTo(page) {
    if (window.ajaxLoadPage) {
        window.ajaxLoadPage(toAppUrl(page), true);
    } else {
        window.location.replace(toAppUrl(page));
    }
}
window.navigateTo = navigateTo;

function showToast(message, isError = false) {
    const existingToast = document.querySelector('.global-toast');
    if (existingToast) existingToast.remove();

    // Dynamically inject shake animations if they don't exist yet
    if (!document.getElementById('toast-shake-style')) {
        const style = document.createElement('style');
        style.id = 'toast-shake-style';
        style.innerHTML = `
            @keyframes toast-shake {
                0%, 100% { transform: translateX(0); }
                10%, 30%, 50%, 70%, 90% { transform: translateX(-8px); }
                20%, 40%, 60%, 80% { transform: translateX(8px); }
            }
            .toast-shake {
                animation: toast-shake 0.5s ease-in-out;
            }
        `;
        document.head.appendChild(style);
    }
    if (isError === 'profanity') {
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-red-950/95 backdrop-blur-md text-white animate-pulse';
        overlay.innerHTML = `
            <span class="material-symbols-outlined text-[120px] mb-6 text-red-500">warning</span>
            <h1 class="text-6xl font-black mb-4 tracking-tighter text-center uppercase text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.8)]">PROFANITY DETECTED</h1>
            <p class="text-2xl font-bold mb-8 text-center px-8 max-w-3xl leading-relaxed">${message}</p>
            <p class="text-lg font-medium mb-12 text-center text-red-300">Your action has been blocked. Repeated offenses will result in an immediate permanent ban.</p>
            <button onclick="this.parentElement.remove()" class="bg-black text-red-500 font-black px-12 py-5 rounded-2xl text-xl hover:bg-red-900 hover:text-white transition-all border-4 border-red-500 hover:scale-105 active:scale-95 shadow-[0_0_50px_rgba(239,68,68,0.5)] uppercase tracking-widest">I Understand and Will Comply</button>
        `;
        document.body.appendChild(overlay);
        return;
    }

    const toast = document.createElement('div');
    toast.className = 'global-toast fixed bottom-6 right-6 z-[250] text-white px-5 py-3.5 rounded-xl shadow-2xl text-sm font-bold flex items-center gap-3 transition-all duration-300 transform translate-y-0 opacity-100';
    
    let iconName = 'check_circle';
    let iconColor = 'text-green-400';
    
    if (isError) {
        toast.className += ' bg-red-600';
        iconName = 'error';
        iconColor = 'text-white';
    } else {
        toast.className += ' bg-slate-900';
    }
    
    toast.innerHTML = `<span class="material-symbols-outlined ${iconColor} text-[20px]">${iconName}</span><span>${message}</span>`;
    document.body.appendChild(toast);
    
    const displayDuration = isError === 'profanity' ? 3200 : 2200;
    
    setTimeout(() => {
        toast.classList.remove('opacity-100');
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, displayDuration);
}

window.showToast = showToast;

const leetMap = {
    'a': '[a@44*]',
    'b': '[b8*]',
    'c': '[c(k*]',
    'd': '[d*]',
    'e': '[e3*]',
    'f': '[f*]',
    'g': '[g9*]',
    'h': '[h*]',
    'i': '[i1!*|]',
    'j': '[j*]',
    'k': '[k*]',
    'l': '[l1|*]',
    'm': '[m*]',
    'n': '[n*]',
    'o': '[o0*]',
    'p': '[p*]',
    'q': '[q*]',
    'r': '[r*]',
    'z': '[z*]',
    's': '[s$5*]',
    't': '[t7*]',
    'u': '[uv*]',
    'v': '[v*]',
    'w': '[w*]',
    'x': '[x*]',
    'y': '[y*]'
};

function makePattern(word, boundaryStart = false, boundaryEnd = false, notPrecededByS = false) {
    const parts = [];
    for (let i = 0; i < word.length; i++) {
        const char = word[i];
        const pattern = leetMap[char] || char;
        parts.push(pattern);
    }
    const separator = '[@*#%!$_\\-\\s.\\d]*';
    let innerPattern = parts.join(separator);
    
    if (notPrecededByS) {
        innerPattern = '(?<![sS])' + innerPattern;
    }
    
    let patternStr = innerPattern;
    if (boundaryStart) patternStr = '\\b' + patternStr;
    if (boundaryEnd) patternStr = patternStr + '\\b';
    
    return new RegExp(patternStr, 'i');
}

const substringWords = [
    'fuck', 'shit', 'bitch', 'cunt', 'pussy', 'whore', 'slut', 'faggot', 'bastard', 'chink', 'retard',
    'asshole', 'badass', 'dumbass', 'jackass'
];

const standaloneWords = [
    'ass', 'asses', 'dick', 'dicks'
];

const patterns = [
    ...substringWords.map(w => makePattern(w, false, false, w === 'nigger')),
    makePattern('nigger', false, false, true),
    ...standaloneWords.map(w => makePattern(w, true, true))
];

function hasProfanity(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return patterns.some(regex => regex.test(lowerText));
}

window.hasProfanity = hasProfanity;


// ─── Route Maps ───────────────────────────────────────────────────────────────

const buyerPages = ['index.html', 'properties.html', 'map.html', 'property-details.html', 'sell.html', 'profile.html', 'shared-filter.html'];
const guestPages  = ['index.html', 'properties.html', 'map.html', 'property-details.html', 'sell.html', 'shared-filter.html'];

const roleHomePage = {
    'Admin':    'admin-panel.html',
    'Employee': 'employee-panel.html',
    'Broker':   'broker-dashboard.html',
    'Buyer':    'index.html',
    'Guest':    'index.html'
};

const roleAllowedPages = {
    'Admin':    ['admin-panel.html', 'employee-panel.html', 'broker-dashboard.html', 'properties.html', 'map.html', 'property-details.html', 'profile.html', 'shared-filter.html'],
    'Employee': ['employee-panel.html', 'broker-dashboard.html', 'properties.html', 'map.html', 'property-details.html', 'profile.html', 'shared-filter.html'],
    'Broker':   ['broker-dashboard.html', 'properties.html', 'map.html', 'property-details.html', 'profile.html', 'shared-filter.html'],
    'Buyer':    buyerPages,
    'Guest':    guestPages
};

// ─── Global Auth Guard (synchronous) ──────────────────────────────────────────

// ─── Global Auth Guard (asynchronous) ──────────────────────────────────────────

isLoginPage = currentPage === 'login.html' || currentPage === 'staff-login.html' || currentPage === 'signup.html';

async function checkAuth() {
    const { data: { session } } = await supabase.auth.getSession();
    
    // For Guest access, we check if they have a 'Guest' role in localStorage
    // or if they are on a guest-allowed page.
    const localRole = localStorage.getItem('role');

    const isGuestPage = guestPages.includes(currentPage);

    if (!session && localRole !== 'Guest' && !isLoginPage) {
        if (isGuestPage) {
            // Allow guest access in-memory only — do NOT persist to localStorage
        } else {
            navigateTo('login.html');
            return;
        }
    }

    let role = localRole;
    if (!session && isGuestPage) {
        role = 'Guest';
        // Do not write Guest to localStorage — session-only
    }

    if (session) {
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).maybeSingle();
        if (profile) {
            role = profile.role;
            const activeRole = localStorage.getItem('role');
            if (role === 'Admin' && (activeRole === 'Broker' || activeRole === 'Employee' || activeRole === 'Admin')) {
                role = activeRole;
            } else {
                localStorage.setItem('role', role); // Sync for sync checks
            }

            // Hydrate savedProperties from Supabase preferences on login
            if (session) {
                const { data: savedProfile } = await supabase
                    .from('profiles')
                    .select('preferences')
                    .eq('id', session.user.id)
                    .single();
                const remoteSaved = savedProfile?.preferences?.saved_listings;
                if (remoteSaved && Array.isArray(remoteSaved)) {
                    localStorage.setItem('savedProperties', JSON.stringify(remoteSaved));
                }
            }
        }
    }

    if (isLoginPage) {
        if (session && role) {
            navigateTo(roleHomePage[role] || 'index.html');
        }
    } else {
        const allowed = roleAllowedPages[role || 'Guest'];
        if (allowed && !allowed.includes(currentPage)) {
            navigateTo(roleHomePage[role || 'Guest']);
        } else {
            if (typeof updateHeaderVisibility === 'function') {
                updateHeaderVisibility();
            }
        }
    }
}

checkAuth();

// ─── Exported functions ───────────────────────────────────────────────────────

window.login = async function(role, name, targetRole = null) {
    if (role === 'Guest') {
        localStorage.setItem('role', 'Guest');
        navigateTo(roleHomePage['Guest']);
        return;
    }
    // For other roles, we expect Supabase session to handle it
    // But we'll keep the role in localStorage for synchronous checks if needed
    localStorage.setItem('role', targetRole || role);
    if (name) localStorage.setItem('userName', name);
    
    // Admin can bypass to different dashboards depending on selected role
    if (role === 'Admin' && targetRole && roleHomePage[targetRole]) {
        navigateTo(roleHomePage[targetRole]);
    } else {
        navigateTo(roleHomePage[role] || 'index.html');
    }
};

window.logout = async function() {
    await supabase.auth.signOut();
    localStorage.removeItem('role');
    localStorage.removeItem('userName');
    navigateTo('login.html');
};

// ─── DOM-ready handlers ───────────────────────────────────────────────────────

function initAppPage() {
    // Re-evaluate currentPage, userRole and isLoginPage context dynamically
    const currentPath = window.location.pathname;
    currentPage = currentPath.split('/').pop() || 'index.html';
    const isSharedFilterRoute = currentPath.includes('/shared-filter/') || currentPage === 'shared-filter';
    if (isSharedFilterRoute) {
        currentPage = 'shared-filter.html';
    } else if (!currentPage.includes('.')) {
        currentPage += '.html';
    }
    userRole = localStorage.getItem('role');
    isLoginPage = currentPage === 'login.html' || currentPage === 'staff-login.html' || currentPage === 'signup.html';

    normalizeInternalLinks();

    // ══════════════════════════════════════════════
    //  LOGIN PAGE
    // ══════════════════════════════════════════════
    // ── Login Page UI Logic ──
    if (isLoginPage) {
        const roleButtons = document.querySelectorAll('#role-tabs button');
        const formTitle   = document.getElementById('form-title');
        const nameField   = document.getElementById('name-field') || document.getElementById('broker-name-field');
        const nameLabel   = document.getElementById('name-label');
        const modeText    = document.getElementById('mode-text');
        const toggleBtn   = document.getElementById('toggle-mode-btn');
        const signInBtn   = document.getElementById('sign-in-btn');
        let selectedRole  = 'Buyer';
        const urlParams   = new URLSearchParams(window.location.search);
        let isSignUp      = (urlParams.get('mode') === 'signup') || (currentPage === 'signup.html');
        let referrerInfo  = null;

        function getInitials(name) {
            if (!name) return 'U';
            return name.split(' ')
                       .filter(Boolean)
                       .map(n => n[0])
                       .join('')
                       .toUpperCase()
                       .slice(0, 2);
        }

        function updateReferralBanner() {
            let banner = document.getElementById('referral-banner');
            if (isSignUp && referrerInfo) {
                if (!banner) {
                    banner = document.createElement('div');
                    banner.id = 'referral-banner';
                    banner.className = 'flex items-center gap-4 p-4 bg-slate-50 border border-slate-100 rounded-2xl mb-6';
                    
                    const form = document.querySelector('form');
                    if (form) {
                        form.parentNode.insertBefore(banner, form);
                    }
                }
                
                const initials = getInitials(referrerInfo.full_name);
                const avatarHtml = referrerInfo.avatar_url 
                    ? `<img src="${referrerInfo.avatar_url}" class="w-full h-full object-cover" alt="Referrer Avatar">`
                    : `<span>${initials}</span>`;
                
                banner.innerHTML = `
                    <div class="flex-shrink-0 w-12 h-12 rounded-full overflow-hidden bg-slate-900 text-white flex items-center justify-center font-bold text-lg">
                        ${avatarHtml}
                    </div>
                    <div class="flex-grow">
                        <p class="text-xs text-slate-500 font-bold uppercase tracking-wider">Special Invitation</p>
                        <p class="text-sm font-semibold text-slate-900">You've been invited by <span class="font-extrabold text-indigo-600">${referrerInfo.full_name}</span> to join EstatePro as a Broker</p>
                    </div>
                `;
                banner.style.display = 'flex';
            } else {
                if (banner) {
                    banner.style.display = 'none';
                }
            }
        }

        function updateUI() {
            if (formTitle) {
                formTitle.textContent = isSignUp ? `Join as ${selectedRole}` : `${selectedRole} Sign In`;
            }
            if (signInBtn) {
                signInBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
            }
            if (modeText) {
                modeText.innerHTML = isSignUp 
                    ? `Already have an account? <button id="toggle-mode-btn" type="button" class="font-bold text-slate-900 hover:underline ml-1">Sign In</button>`
                    : `Don't have an account? <button id="toggle-mode-btn" type="button" class="font-bold text-slate-900 hover:underline ml-1">Sign Up</button>`;
                
                // Re-bind click event since we replaced innerHTML
                document.getElementById('toggle-mode-btn').onclick = (e) => {
                    e.preventDefault();
                    isSignUp = !isSignUp;
                    updateUI();
                };
            }
            if (nameField) {
                if (isSignUp) {
                    nameField.style.display = 'block';
                    if (nameLabel) nameLabel.textContent = selectedRole === 'Broker' ? 'Company/Full Name' : 'Full Name';
                } else {
                    nameField.style.display = 'none';
                }
            }
            updateReferralBanner();
        }

        function resetRoleTabs() {
            roleButtons.forEach(b => {
                b.className = 'flex-1 py-2.5 px-3 text-center text-[10px] font-black uppercase tracking-widest rounded-lg role-tab-inactive hover:text-slate-900 transition-colors';
            });
        }

        function selectRole(role) {
            let normalizedRole = role;
            if (role) {
                normalizedRole = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
            }
            selectedRole = normalizedRole;
            resetRoleTabs();
            
            const btn = Array.from(roleButtons).find(b => b.textContent.trim().toLowerCase() === normalizedRole.toLowerCase());
            if (btn) {
                btn.className = 'flex-1 py-2.5 px-3 text-center text-[10px] font-black uppercase tracking-widest rounded-lg role-tab-active font-bold scale-105 transition-all';
            }

            updateUI();
        }

        roleButtons.forEach(btn => {
            btn.onclick = () => selectRole(btn.textContent.trim());
        });

        // Initialize toggle if it exists initially
        if (toggleBtn) {
            toggleBtn.onclick = (e) => {
                e.preventDefault();
                isSignUp = !isSignUp;
                updateUI();
            };
        }

        // Handle URL parameters for role selection
        const urlRole = urlParams.get('role');
        if (urlRole) selectRole(urlRole);
        else selectRole(currentPage === 'staff-login.html' ? 'Admin' : 'Buyer');

        // Fetch referrer details if ref is present
        const refParam = urlParams.get('ref') || referrerId || localStorage.getItem('referred_by');
        if (refParam) {
            referrerId = refParam;
            localStorage.setItem('referred_by', refParam);
            
            supabase
                .from('profiles')
                .select('full_name, avatar_url')
                .eq('id', refParam)
                .single()
                .then(({ data, error }) => {
                    if (data && !error) {
                        referrerInfo = data;
                        updateReferralBanner();
                    }
                });
        }

        // Handle Enter key in form — direct keydown listeners are more reliable
        // than form.onsubmit because sign-in-btn is type="button"
        ['input-email', 'input-password', 'input-name'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && signInBtn && !signInBtn.disabled) {
                        e.preventDefault();
                        signInBtn.click();
                    }
                });
            }
        });

        // Sign In button
        if (signInBtn) {
            signInBtn.onclick = async (e) => {
                e.preventDefault();
                const email = document.getElementById('input-email')?.value?.trim();
                const password = document.getElementById('input-password')?.value?.trim();
                const name = document.getElementById('input-name')?.value?.trim() || '';
                
                if (!email || !password) {
                    showToast('Please enter both email and password.');
                    return;
                }

                if (isSignUp && !name) {
                    showToast('Please enter your name to create an account.');
                    return;
                }

                signInBtn.disabled = true;
                signInBtn.textContent = 'Processing...';

                try {
                    if (isSignUp) {
                        const { data, error } = await supabase.auth.signUp({
                            email,
                            password,
                        });
                        if (error) throw error;
                        
                        if (data.user) {
                            // Create profile
                            const profileData = {
                                id: data.user.id,
                                full_name: name,
                                role: selectedRole
                            };
                            const referredBy = referrerId || localStorage.getItem('referred_by');
                            if (referredBy) {
                                profileData.referred_by = referredBy;
                                profileData.preferences = {
                                    ...(profileData.preferences || {}),
                                    referrer_id: referredBy
                                };
                            }
                            const { error: profileError } = await supabase.from('profiles').insert(profileData);
                            if (profileError) throw profileError;
                            
                            // Clear referral after successful profile creation
                            localStorage.removeItem('referred_by');
                        }

                        showToast('Account created successfully!');
                        
                        if (data.session) {
                            // Automatically sign in if email confirmation is disabled
                            window.login(selectedRole, name);
                            return;
                        }

                        isSignUp = false;
                        updateUI();
                    } else {
                        const { data, error } = await supabase.auth.signInWithPassword({
                            email,
                            password
                        });
                        if (error) throw error;

                        // Fetch profile to get role
                        let { data: profile, error: profileError } = await supabase
                            .from('profiles')
                            .select('role, full_name')
                            .eq('id', data.user.id)
                            .maybeSingle();
                        
                        if (profileError) throw profileError;

                        // Auto-create profile if missing (e.g. from a previously failed sign-up)
                        if (!profile) {
                            const profileData = {
                                id: data.user.id,
                                full_name: email.split('@')[0], // fallback name
                                role: selectedRole
                            };
                            const { error: insertError } = await supabase.from('profiles').insert(profileData);
                            if (insertError) throw insertError;
                            profile = profileData;
                        }

                        let matched = (profile.role === selectedRole);
                        if (!matched && profile.role === 'Admin' && (selectedRole === 'Broker' || selectedRole === 'Employee' || selectedRole === 'Admin')) {
                            matched = true;
                        }
                        if (!matched) {
                            await supabase.auth.signOut();
                            throw new Error(`This account is registered as a ${profile.role}. Please select the correct role above.`);
                        }

                        window.login(profile.role, profile.full_name, selectedRole);
                    }
                } catch (err) {
                    console.error('Authentication error:', err);
                    // Detailed error message if available
                    let msg = err.message || 'Authentication failed.';
                    if (err.status === 400 && msg.toLowerCase().includes('invalid')) {
                        msg = 'Invalid email or password format. Please check your details.';
                    }
                    showToast(msg);
                } finally {
                    signInBtn.disabled = false;
                    signInBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
                }
            };
        }

        // Guest button
        const guestBtn = document.getElementById('guest-btn');
        if (guestBtn) {
            guestBtn.onclick = (e) => {
                e.preventDefault();
                window.login('Guest');
            };
        }

        return;
    }

    // ── Global Header Visibility ──
    updateHeaderVisibility = function() {
        let currentRoleRaw = localStorage.getItem('role') || 'Guest';
        let currentRole = currentRoleRaw;
        if (currentRoleRaw) {
            currentRole = currentRoleRaw.charAt(0).toUpperCase() + currentRoleRaw.slice(1).toLowerCase();
        }
        const isStaff = ['Admin', 'Employee', 'Broker'].includes(currentRole);
        
        // Find all trailing actions containers
        const containers = [];
        const accountIcons = document.querySelectorAll('.material-symbols-outlined');
        accountIcons.forEach(el => {
            if (el.textContent.trim() === 'account_circle' || el.textContent.trim() === 'logout') {
                const c = el.closest('.items-center.gap-4') || el.closest('#mobile-trailing-actions');
                if (c && !containers.includes(c)) containers.push(c);
            }
        });
        
        // Fallback query if standard icon isn't found
        if (containers.length === 0) {
            const signInBtns = document.querySelectorAll('button, a');
            signInBtns.forEach(el => {
                if (el.textContent.trim().includes('Sign In') || el.textContent.trim().includes('Sign Up')) {
                    const c = el.closest('.items-center.gap-4') || el.closest('#mobile-trailing-actions');
                    if (c && !containers.includes(c)) containers.push(c);
                }
            });
        }
        
        // Also manually add the mobile container if empty
        const mobileContainer = document.getElementById('mobile-trailing-actions');
        if (mobileContainer && !containers.includes(mobileContainer)) containers.push(mobileContainer);

        containers.forEach(container => {
            const isMobileContainer = container.id === 'mobile-trailing-actions' || container.classList.contains('flex-col');
            
            if (currentRole === 'Guest') {
                if (isMobileContainer) {
                    container.innerHTML = `
                        <a href="${window.toAppUrl('login.html')}" class="w-full text-center border border-slate-200 text-slate-700 px-5 py-3 rounded-xl font-bold text-xs hover:bg-slate-50 transition-colors uppercase tracking-wider block">
                            Sign In
                        </a>
                        <a href="${window.toAppUrl('login.html?mode=signup')}" class="w-full text-center bg-slate-900 text-white px-5 py-3 rounded-xl font-bold text-xs hover:bg-slate-800 transition-colors uppercase tracking-wider shadow-sm block">
                            Sign Up
                        </a>
                    `;
                } else {
                    container.innerHTML = `
                        <a href="${window.toAppUrl('login.html')}" class="text-slate-600 hover:text-slate-900 transition-colors font-bold text-xs uppercase tracking-wider px-3 py-2 inline-block">
                            Sign In
                        </a>
                        <a href="${window.toAppUrl('login.html?mode=signup')}" class="bg-slate-900 text-white px-5 py-2.5 rounded-lg font-bold text-xs hover:bg-slate-800 transition-colors uppercase tracking-wider shadow-sm ml-2 inline-block">
                            Sign Up
                        </a>
                    `;
                }
            } else if (currentRole === 'Buyer') {
                if (isMobileContainer) {
                    container.innerHTML = `
                        <a href="${window.toAppUrl('profile.html')}" class="w-full text-center border border-slate-200 text-slate-700 px-5 py-3 rounded-xl font-bold text-xs hover:bg-slate-50 transition-colors uppercase tracking-wider flex items-center justify-center gap-2">
                            <span class="material-symbols-outlined text-[18px]">account_circle</span>
                            Profile
                        </a>
                        <button onclick="window.logout()" class="w-full text-center bg-slate-100 text-slate-700 px-5 py-3 rounded-xl font-bold text-xs hover:bg-slate-200 transition-colors uppercase tracking-wider flex items-center justify-center gap-2">
                            <span class="material-symbols-outlined text-[18px]">logout</span>
                            Sign Out
                        </button>
                    `;
                } else {
                    container.innerHTML = `
                        <button onclick="window.location.href=window.toAppUrl('profile.html')" class="text-slate-500 hover:text-slate-900 transition-colors flex items-center" title="Signed in as Buyer — Go to Profile">
                            <span class="material-symbols-outlined text-[24px]">account_circle</span>
                        </button>
                        <button onclick="window.logout()" class="text-slate-500 hover:text-slate-900 transition-colors flex items-center ml-2" title="Sign Out">
                            <span class="material-symbols-outlined text-[24px]">logout</span>
                        </button>
                    `;
                }
            } else {
                if (isMobileContainer) {
                    container.innerHTML = `
                        <a href="${window.toAppUrl(roleHomePage[currentRole] || 'index.html')}" class="w-full text-center bg-slate-900 text-white px-5 py-3 rounded-xl font-bold text-xs hover:bg-slate-800 transition-colors uppercase tracking-wider shadow-sm flex items-center justify-center gap-2">
                            <span class="material-symbols-outlined text-[18px]">dashboard</span>
                            Dashboard
                        </a>
                        <button onclick="window.logout()" class="w-full text-center bg-slate-100 text-slate-700 px-5 py-3 rounded-xl font-bold text-xs hover:bg-slate-200 transition-colors uppercase tracking-wider flex items-center justify-center gap-2">
                            <span class="material-symbols-outlined text-[18px]">logout</span>
                            Sign Out
                        </button>
                    `;
                } else {
                    container.innerHTML = `
                        <a href="${window.toAppUrl(roleHomePage[currentRole] || 'index.html')}" class="bg-slate-900 text-white px-5 py-2 rounded-lg font-bold text-xs hover:bg-slate-800 transition-colors uppercase tracking-wider shadow-sm mr-2 flex items-center">
                            Dashboard
                        </a>
                        <button onclick="window.logout()" class="text-slate-500 hover:text-slate-900 transition-colors flex items-center" title="Signed in as ${currentRole} — Sign Out">
                            <span class="material-symbols-outlined text-[24px]">logout</span>
                        </button>
                    `;
                }
            }
        });
    }

    // Fix hover-only dropdowns for touch devices
    function initTouchDropdowns() {
        document.querySelectorAll('.group').forEach(group => {
            const trigger = group.querySelector('button, a');
            const dropdown = group.querySelector('[class*="group-hover"]');
            if (!trigger || !dropdown) return;

            trigger.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const isVisible = dropdown.style.opacity === '1';
                // Close all
                document.querySelectorAll('.group [class*="group-hover"]').forEach(d => {
                    d.style.opacity = '0';
                    d.style.visibility = 'hidden';
                    d.style.pointerEvents = 'none';
                });
                // Toggle this one
                if (!isVisible) {
                    dropdown.style.opacity = '1';
                    dropdown.style.visibility = 'visible';
                    dropdown.style.pointerEvents = 'auto';
                }
            });
        });

        // Close on outside touch
        document.addEventListener('touchend', (e) => {
            if (!e.target.closest('.group')) {
                document.querySelectorAll('.group [class*="group-hover"]').forEach(d => {
                    d.style.opacity = '0';
                    d.style.visibility = 'hidden';
                    d.style.pointerEvents = 'none';
                });
            }
        });
    }

    // Call after DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTouchDropdowns);
    } else {
        initTouchDropdowns();
    }

    updateHeaderVisibility();


    // ── Logout handled via account circle click ──

    // ── Broker Dashboard: populate name + wire listings manager ──
    if (userRole === 'Broker' && currentPage === 'broker-dashboard.html') {
        const brokerName = localStorage.getItem('userName');
        if (brokerName) {
            const nameEl = document.getElementById('broker-company-name');
            if (nameEl) nameEl.textContent = brokerName;

            const greeting = document.querySelector('main header p');
            if (greeting) greeting.textContent = `Welcome back, ${brokerName}. Here is your portfolio performance.`;
        }

        // Setup Broker Referral Program
        supabase.auth.getSession().then(async ({ data: { session } }) => {
            if (session) {
                const userId = session.user.id;
                const referralUrl = `${window.location.origin}/login.html?ref=${userId}&role=broker`;
                
                const linkInput = document.getElementById('referral-link-input');
                if (linkInput) linkInput.value = referralUrl;

                const copyBtn = document.getElementById('copy-referral-btn');
                if (copyBtn) {
                    copyBtn.onclick = () => {
                        navigator.clipboard.writeText(referralUrl).then(() => {
                            showToast('Referral link copied to clipboard!');
                        }).catch(() => {
                            showToast('Failed to copy referral link.', true);
                        });
                    };
                }

                // Load referral stats
                const loadReferralStats = async () => {
                    const { data: referredUsers, error } = await supabase
                        .from('profiles')
                        .select('id, role')
                        .eq('referred_by', userId);

                    if (!error && referredUsers) {
                        const invitedCount = referredUsers.length;
                        const activeCount = referredUsers.filter(u => u.role === 'Buyer' || u.role === 'Broker').length;

                        const invitedEl = document.getElementById('invited-count');
                        const activeEl = document.getElementById('active-referred-count');
                        if (invitedEl) invitedEl.textContent = invitedCount;
                        if (activeEl) activeEl.textContent = activeCount;
                    }
                };
                await loadReferralStats();
            }
        });

        // Retrieve and apply the uploaded avatar from broker_avatar_${userId} localStorage key
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                const cachedAvatar = localStorage.getItem(`broker_avatar_${session.user.id}`);
                if (cachedAvatar) {
                    const profileImgEl = document.getElementById('broker-profile-img');
                    if (profileImgEl) {
                        profileImgEl.src = cachedAvatar;
                    }
                }
            }
        });

        // Sidebar Logout
        const sidebarLogout = document.getElementById('sidebar-logout-btn');
        if (sidebarLogout) sidebarLogout.addEventListener('click', window.logout);

        // Sidebar Add Listing
        const sidebarAddBtn = document.getElementById('sidebar-add-listing-btn');
        if (sidebarAddBtn) sidebarAddBtn.addEventListener('click', () => openListingModal(null));

        // Sidebar & Mobile Navigation Interactivity
        const sidebarLinks = document.querySelectorAll('#broker-sidebar a');
        const mobileNavBtns = document.querySelectorAll('.mobile-nav-btn');
        
        const activateBrokerTab = (hash) => {
            if (!hash || !hash.startsWith('#')) return;
            const targetLink = Array.from(sidebarLinks).find(l => l.getAttribute('href') === hash);
            if (!targetLink) return;

            // Active state management (Sidebar links)
            sidebarLinks.forEach(l => {
                l.classList.remove('bg-white', 'text-slate-900', 'shadow-sm', 'ring-1', 'ring-slate-200');
                l.classList.add('text-slate-500', 'hover:bg-slate-100', 'hover:text-slate-900');
                l.setAttribute('aria-selected', 'false');
            });
            targetLink.classList.add('bg-white', 'text-slate-900', 'shadow-sm', 'ring-1', 'ring-slate-200');
            targetLink.classList.remove('text-slate-500', 'hover:bg-slate-100', 'hover:text-slate-900');
            targetLink.setAttribute('aria-selected', 'true');

            // Active state management (Mobile Nav buttons)
            mobileNavBtns.forEach(btn => {
                if (btn.getAttribute('data-tab') === hash) {
                    btn.classList.add('active-mobile-tab');
                    btn.setAttribute('aria-selected', 'true');
                } else {
                    btn.classList.remove('active-mobile-tab');
                    btn.setAttribute('aria-selected', 'false');
                }
            });

            // Section handling
            const targetId = 'tab-' + hash.substring(1).replace('-section', '');
            
            // Hide all tabs
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.add('hidden');
                tab.classList.remove('block', 'flex');
            });
            
            // Show target tab
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
                targetEl.classList.remove('hidden');
                if (targetId === 'tab-messages') {
                    targetEl.classList.add('flex');
                    if (typeof initBrokerChat === 'function') initBrokerChat();
                } else {
                    targetEl.classList.add('block');
                }
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        };

        // Expose globally
        window.activateBrokerTab = activateBrokerTab;

        // Activate correct tab on load based on hash (default to overview)
        activateBrokerTab(window.location.hash || '#overview-section');

        // Sidebar link click listeners
        sidebarLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                const href = link.getAttribute('href');
                if (href && href.startsWith('#')) {
                    e.preventDefault();
                    e.stopPropagation();
                    history.pushState(null, '', href);
                    activateBrokerTab(href);
                }
            });
        });

        // Mobile bottom nav button click listeners
        mobileNavBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const hash = btn.getAttribute('data-tab');
                if (hash && hash.startsWith('#')) {
                    e.preventDefault();
                    e.stopPropagation();
                    history.pushState(null, '', hash);
                    activateBrokerTab(hash);
                }
            });
        });

        // Listen for history popstate events (browser back/forward)
        window.addEventListener('popstate', () => {
            activateBrokerTab(window.location.hash || '#overview-section');
        });

        // Header Actions
        const downloadBtn = Array.from(document.querySelectorAll('header button')).find(b => 
            b.querySelector('.material-symbols-outlined')?.textContent.trim() === 'download'
        );
        if (downloadBtn) {
            downloadBtn.addEventListener('click', async () => {
                const { data: { user } } = await supabase.auth.getUser();
                let listings = await getListings();
                if (user) {
                    listings = listings.filter(l => l.broker_id === user.id);
                }
                const inquiries = await getInquiries();
                const brokerName = localStorage.getItem('userName') || 'Broker';
                const generatedAt = new Date().toLocaleString('en-IN');

                // Build Excel-compatible CSV content for two sheets via HTML table format
                // Using Excel XML Spreadsheet format for native .xls support
                const xmlHeader = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`;

                const xmlFooter = `</Workbook>`;

                const escXml = (val) => String(val ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

                const makeSheet = (name, headers, rows) => `
  <Worksheet ss:Name="${escXml(name)}">
    <Table>
      <Row>${headers.map(h => `<Cell><Data ss:Type="String">${escXml(h)}</Data></Cell>`).join('')}</Row>
      ${rows.map(row => `<Row>${row.map(cell => `<Cell><Data ss:Type="String">${escXml(cell)}</Data></Cell>`).join('')}</Row>`).join('')}
    </Table>
  </Worksheet>`;

                const listingHeaders = ['ID', 'Title', 'Location', 'Price (Cr)', 'Intent', 'Type', 'Status', 'Beds', 'Baths', 'SqFt', 'Views', 'Listed On'];
                const listingRows = listings.map(l => [
                    l.id,
                    l.title,
                    l.location,
                    l.price,
                    l.intent,
                    l.type,
                    l.status,
                    l.beds,
                    l.baths,
                    l.sqft,
                    l.views || 0,
                    l.created_at ? new Date(l.created_at).toLocaleDateString('en-IN') : '—'
                ]);

                const inquiryHeaders = ['ID', 'Name', 'Message', 'Type', 'Read', 'Broker Reply', 'Received At'];
                const inquiryRows = inquiries.map(i => [
                    i.id,
                    i.name,
                    i.message,
                    i.type,
                    i.read ? 'Yes' : 'No',
                    i.broker_reply || '',
                    i.created_at ? new Date(i.created_at).toLocaleDateString('en-IN') : '—'
                ]);

                const summaryHeaders = ['Field', 'Value'];
                const summaryRows = [
                    ['Broker', brokerName],
                    ['Generated At', generatedAt],
                    ['Total Listings', listings.length],
                    ['Total Inquiries', inquiries.length],
                    ['Total Views', listings.reduce((sum, l) => sum + (l.views || 0), 0)],
                ];

                const xmlContent = [
                    xmlHeader,
                    makeSheet('Summary', summaryHeaders, summaryRows),
                    makeSheet('Listings', listingHeaders, listingRows),
                    makeSheet('Inquiries', inquiryHeaders, inquiryRows),
                    xmlFooter
                ].join('\n');

                const blob = new Blob([xmlContent], { type: 'application/vnd.ms-excel' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `estatepro-broker-report-${new Date().toISOString().slice(0,10)}.xls`;
                a.click();
                URL.revokeObjectURL(url);
                showToast('Portfolio report exported as Excel.');
            });
        }

        const dateFilter = document.querySelector('header .relative button');
        if (dateFilter) {
            const ranges = ['Last 7 Days', 'Last 30 Days', 'Last 90 Days'];
            let rangeIdx = 1;
            dateFilter.addEventListener('click', () => {
                rangeIdx = (rangeIdx + 1) % ranges.length;
                const textNodes = Array.from(dateFilter.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
                const rangeTextNode = textNodes.find(n => n.textContent.trim().length > 0);
                if (rangeTextNode) rangeTextNode.textContent = ` ${ranges[rangeIdx]} `;
                showToast(`Filter changed to ${ranges[rangeIdx]}`);
            });
        }

        // View All Buttons
        const viewAllListings = document.getElementById('view-all-listings-btn');
        if (viewAllListings) {
            viewAllListings.addEventListener('click', () => {
                history.pushState(null, '', '#listings-section');
                activateBrokerTab('#listings-section');
            });
        }

        const viewAllMessages = document.getElementById('view-all-messages-btn');
        if (viewAllMessages) {
            viewAllMessages.addEventListener('click', () => {
                history.pushState(null, '', '#messages-section');
                activateBrokerTab('#messages-section');
            });
        }

        const saveSettingsBtn = document.getElementById('save-settings-btn');
        if (saveSettingsBtn) {
            saveSettingsBtn.addEventListener('click', () => {
                showToast('Settings saved successfully.');
            });
        }

        // Init managers
        initListingsManager();
        initInquiriesManager();
        initCustomFiltersManager();
        initNotificationsManager();

        // Global Real-time Message Listener for Broker Dashboard
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session && session.user) {
                const user = session.user;
                supabase.channel(`global_broker_chat_notification_${user.id}`)
                    .on('postgres_changes', {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'messages',
                        filter: `broker_id=eq.${user.id}`
                    }, async (payload) => {
                        const msg = payload.new;
                        // Alert only on incoming messages from buyers (sender is not the broker themselves)
                        if (msg.sender_id !== user.id) {
                            // 1. Check if the broker is currently actively chatting in this exact viewport
                            const isActivelyChatting = currentChatConversation &&
                                currentChatConversation.buyerId === msg.buyer_id &&
                                currentChatConversation.listingId === msg.listing_id &&
                                !document.getElementById('tab-messages').classList.contains('hidden');

                            if (!isActivelyChatting) {
                                // Fetch buyer name and listing title dynamically to construct a beautiful premium notification
                                const { data: buyerProf } = await supabase.from('profiles').select('full_name').eq('id', msg.buyer_id).single();
                                const { data: listingData } = await supabase.from('listings').select('title').eq('id', msg.listing_id).single();
                                
                                const buyerName = buyerProf?.full_name || 'Buyer';
                                const propTitle = listingData?.title || 'Property';

                                activeChatNames[msg.buyer_id] = buyerName;

                                // Show a rich notification toast
                                showToast(`💬 New message from ${buyerName} regarding "${propTitle}": "${msg.content}"`);

                                // Mark conversation as unread
                                const key = `${msg.buyer_id}-${msg.listing_id}`;
                                unreadConversations.add(key);

                                // Update unread sidebar badge
                                updateSidebarMessagesBadge();

                                // If currently on the Messages tab, refresh the left conversations list
                                const listEl = document.getElementById('chat-list');
                                if (listEl && !document.getElementById('tab-messages').classList.contains('hidden')) {
                                    if (typeof initBrokerChat === 'function') initBrokerChat();
                                }
                            }
                        }
                    })
                    .subscribe();
            }
        });
    }

    // ── Buyer Property Details ──
    if (currentPage === 'property-details.html') {
        // Handled in initBuyerPageInteractions
    }

    if (buyerPages.includes(currentPage)) {
        initBuyerPageInteractions();
    }

    if (userRole === 'Admin' && currentPage === 'admin-panel.html') {
        initAdminPanelInteractions();
    }

    if (userRole === 'Employee' && currentPage === 'employee-panel.html') {
        initEmployeePanelInteractions();
    }

    // Run the page's registered SPA initializer if it exists
    if (window.spaPageInit && window.spaPageInit[currentPage]) {
        try {
            window.spaPageInit[currentPage]();
        } catch (e) {
            console.error(`Error executing SPA page initializer for ${currentPage}:`, e);
        }
    }

    window.initAppPageHasRun = true;
}
document.addEventListener('DOMContentLoaded', initAppPage);

// ══════════════════════════════════════════════════════
//  BROKER LISTINGS MANAGER (localStorage-based CRUD)
// ══════════════════════════════════════════════════════

async function getListings() {
    const { data, error } = await supabase.from('listings').select('*').order('created_at', { ascending: false });
    if (error) {
        console.error('Error fetching listings:', error);
        return [];
    }
    return data;
}

async function saveListings(listings) {
    // This function is no longer needed in its old form as we save individual items
}

async function initListingsManager() {
    await renderListings();
    injectListingModal();
}

function updateTrendBadge(items, elementId, dateField = 'created_at', valueField = null) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    let current = 0;
    let previous = 0;

    items.forEach(item => {
        const date = new Date(item[dateField]);
        const val = valueField ? (item[valueField] || 0) : 1;
        if (date >= startOfThisMonth) {
            current += val;
        } else if (date >= startOfLastMonth && date <= endOfLastMonth) {
            previous += val;
        }
    });

    let percentage = 0;
    if (previous === 0) {
        percentage = current > 0 ? 100 : 0;
    } else {
        percentage = ((current - previous) / previous) * 100;
    }

    const isPositive = percentage >= 0;
    const absVal = Math.abs(percentage).toFixed(1);
    
    if (isPositive) {
        el.className = 'flex items-center text-secondary font-body-sm text-body-sm bg-secondary-container px-2 py-0.5 rounded-full';
        el.innerHTML = `<span class="material-symbols-outlined text-[14px] mr-1">trending_up</span>${absVal}%`;
    } else {
        el.className = 'flex items-center text-error font-body-sm text-body-sm bg-error-container px-2 py-0.5 rounded-full';
        el.innerHTML = `<span class="material-symbols-outlined text-[14px] mr-1">trending_down</span>${absVal}%`;
    }
}

async function renderListings() {
    const { data: { user } } = await supabase.auth.getUser();
    let listings = await getListings();
    
    // Filter listings so the broker only sees and manages their own listings
    if (user) {
        listings = listings.filter(l => l.broker_id === user.id);
    }
    
    // Dynamically update listings overview stats
    const viewsEl = document.getElementById('stat-total-views');
    if (viewsEl) {
        const totalViews = listings.reduce((sum, l) => sum + (l.views || 0), 0);
        viewsEl.textContent = totalViews.toLocaleString();
    }
    
    const listingsCountEl = document.getElementById('stat-total-listings');
    if (listingsCountEl) {
        listingsCountEl.textContent = listings.length.toLocaleString();
    }
    
    // Update KPI trend badges
    updateTrendBadge(listings, 'stat-views-trend', 'created_at', 'views');
    updateTrendBadge(listings, 'stat-listings-trend', 'created_at');
    
    // Render widget (max 3)
    const tbodyWidget = document.getElementById('listings-tbody-widget');
    if (tbodyWidget) {
        tbodyWidget.innerHTML = generateListingsHTML(listings.slice(0, 3), false);
    }
    
    // Render full
    const tbodyFull = document.getElementById('listings-tbody-full');
    if (tbodyFull) {
        tbodyFull.innerHTML = generateListingsHTML(listings, true);
    }
}

function generateListingsHTML(listings, showViews) {
    if (!listings.length) return '<tr><td colspan="6" class="p-8 text-center text-slate-400">No listings found. Click "Add Listing" to start.</td></tr>';
    
    return listings.map(l => {
        let badgeClass = 'bg-surface-container-high text-on-surface-variant';
        if (l.status === 'Active') badgeClass = 'bg-secondary-fixed text-on-secondary-fixed-variant';
        else if (l.status === 'Pending') badgeClass = 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
        else if (l.status === 'Flagged') badgeClass = 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
        else if (l.status === 'Sold') badgeClass = 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300';

        return `
        <tr class="border-b border-surface-variant hover:bg-surface-container transition-colors group" data-id="${l.id}">
          <td class="p-4">
            <div class="flex items-center gap-3">
              <img src="${l.img || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80'}" alt="Property" class="w-12 h-12 rounded object-cover shadow-sm border border-outline-variant">
              <div>
                <p class="font-medium text-primary">${escHtml(l.title)}</p>
                <p class="text-on-surface-variant text-xs">${escHtml(l.location)}</p>
              </div>
            </div>
          </td>
          <td class="p-4">
            <span class="${badgeClass} px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider">${l.status}</span>
          </td>
          <td class="p-4 font-medium">${escHtml(l.price)}</td>
          ${showViews ? `<td class="p-4">${(l.views || 0).toLocaleString()}</td>` : ''}
          <td class="p-4">
            <div class="text-sm font-medium text-slate-900">${listingAge(l.created_at).date}</div>
            <div class="text-[10px] text-slate-500 font-bold uppercase tracking-wide">${listingAge(l.created_at).label}</div>
          </td>
          <td class="p-4 text-right">
            <div class="flex justify-end gap-2">
              <button onclick="shareListing(${l.id})" class="p-1.5 text-on-surface-variant hover:text-primary rounded hover:bg-surface-container" title="Share">
                <span class="material-symbols-outlined text-[20px]">share</span>
              </button>
              <button onclick="openListingModal(${l.id})" class="p-1.5 text-on-surface-variant hover:text-primary rounded hover:bg-surface-container" title="Edit">
                <span class="material-symbols-outlined text-[20px]">edit</span>
              </button>
              <button onclick="deleteListing(${l.id})" class="p-1.5 text-on-surface-variant hover:text-error rounded hover:bg-error-container" title="Delete">
                <span class="material-symbols-outlined text-[20px]">delete</span>
              </button>
            </div>
          </td>
        </tr>
        `;
    }).join('');
}

async function deleteListing(id) {
    if (!confirm('Delete this listing?')) return;
    const { error } = await supabase.from('listings').delete().eq('id', id);
    if (error) {
        showToast('Error deleting listing: ' + error.message);
    } else {
        showToast('Listing deleted.');
        await renderListings();
    }
}

window.deleteListing = deleteListing;

function shareListing(id) {
    const url = window.location.origin + '/property-details.html?id=' + id;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Listing link copied to clipboard!');
    }).catch(() => {
        showToast('Failed to copy link.');
    });
}

window.shareListing = shareListing;

async function openListingModal(id) {
    const modal = document.getElementById('listing-modal');
    
    // Reset any validation warnings
    const errorBanner = document.getElementById('modal-validation-error');
    if (errorBanner) {
        errorBanner.classList.add('hidden');
        errorBanner.classList.remove('flex');
        const textSpan = errorBanner.querySelector('span:last-child');
        if (textSpan) textSpan.textContent = 'Please fill in all fields with valid information before saving.';
    }
    const inputsToReset = [
        'modal-prop-title', 'modal-location', 'modal-price', 
        'modal-intent', 'modal-type', 'modal-status', 
        'modal-beds', 'modal-baths', 'modal-sqft', 
        'modal-lat', 'modal-lng'
    ];
    inputsToReset.forEach(inputId => {
        const el = document.getElementById(inputId);
        if (el) {
            el.classList.remove('border-red-500', 'ring-2', 'ring-red-100');
            el.classList.add('border-outline-variant');
        }
    });
    const uploadZoneEl = document.getElementById('modal-upload-zone');
    if (uploadZoneEl) {
        uploadZoneEl.classList.remove('border-red-500', 'bg-red-50/20');
        uploadZoneEl.classList.add('border-slate-200');
    }

    let listing = null;
    if (id) {
        const { data, error } = await supabase.from('listings').select('*').eq('id', id).single();
        if (error) {
            showToast('Error fetching listing: ' + error.message);
            return;
        }
        listing = data;
    }

    // Reset media state for this modal session
    uploadedMedia = [];

    // Load existing media from listing_media when editing
    if (id) {
        const { data: mediaRows } = await supabase
            .from('listing_media')
            .select('*')
            .eq('listing_id', id)
            .order('sort_order', { ascending: true });
        if (mediaRows && mediaRows.length > 0) {
            uploadedMedia = mediaRows.map(row => ({
                url: row.url,
                media_type: row.media_type,
                is_cover: row.is_cover || false,
                alt_text: row.alt_text || null,
                thumbnail_url: row.thumbnail_url || null
            }));
        } else if (listing && listing.img) {
            // Fallback: listing has img but no listing_media rows — treat img as single cover image
            uploadedMedia = [{
                url: listing.img,
                media_type: 'image',
                is_cover: true,
                alt_text: null
            }];
        }
    }

    document.getElementById('modal-title').textContent   = listing ? 'Edit Listing' : 'Add New Listing';
    document.getElementById('modal-id').value            = listing ? listing.id : '';
    document.getElementById('modal-prop-title').value    = listing ? listing.title    : '';
    document.getElementById('modal-location').value      = listing ? listing.location  : '';
    // Populate price display field for editing
    const existingPrice = listing ? listing.price : '';
    document.getElementById('modal-price').value = existingPrice;
    const dispField = document.getElementById('modal-price-display');
    const unitField = document.getElementById('modal-price-unit');
    if (dispField && existingPrice !== '') {
      const p = parseFloat(existingPrice);
      if (listing && listing.intent === 'Rent') {
        // Show in Lac
        unitField.value = 'lac';
        dispField.value = (p * 100).toFixed(2);
      } else {
        unitField.value = 'cr';
        dispField.value = p;
      }
      // Trigger update of hidden input and preview
      dispField.dispatchEvent(new Event('input'));
    }
    document.getElementById('modal-intent').value        = listing ? listing.intent    : 'Buy';
    document.getElementById('modal-type').value          = listing ? listing.type      : 'Apartment';
    const statusSelect = document.getElementById('modal-status');
    if (statusSelect) {
        statusSelect.innerHTML = '';
        const allowedStatuses = userRole === 'Broker' 
            ? ['Draft', 'Pending', 'Sold']
            : ['Draft', 'Pending', 'Under Review', 'Active', 'Rejected', 'Suspended', 'Sold'];
        
        const currentStatus = listing ? listing.status : (userRole === 'Broker' ? 'Draft' : 'Active');
        const finalStatuses = [...allowedStatuses];
        if (!finalStatuses.includes(currentStatus)) {
            finalStatuses.push(currentStatus);
        }
        
        finalStatuses.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s === 'Active' ? 'Approved' : s;
            statusSelect.appendChild(opt);
        });
        statusSelect.value = currentStatus;
    }
    document.getElementById('modal-beds').value          = listing ? listing.beds      : '0';
    document.getElementById('modal-baths').value         = listing ? listing.baths     : '0';
    document.getElementById('modal-sqft').value          = listing ? listing.sqft      : '0';
    document.getElementById('modal-views').value         = listing ? listing.views     : '0';
    document.getElementById('modal-lat').value           = listing ? (listing.lat || '') : '';
    document.getElementById('modal-lng').value           = listing ? (listing.lng || '') : '';

    // Render the media grid (populated from listing_media or empty)
    renderMediaGrid();

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

window.openListingModal = openListingModal;

function closeListingModal() {
    const modal = document.getElementById('listing-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

window.closeListingModal = closeListingModal;

async function saveListingForm() {
    const id       = document.getElementById('modal-id').value;
    const titleEl    = document.getElementById('modal-prop-title');
    const locationEl = document.getElementById('modal-location');
    const priceEl    = document.getElementById('modal-price');
    const intentEl   = document.getElementById('modal-intent');
    const typeEl     = document.getElementById('modal-type');
    const statusEl   = document.getElementById('modal-status');
    const bedsEl     = document.getElementById('modal-beds');
    const bathsEl    = document.getElementById('modal-baths');
    const sqftEl     = document.getElementById('modal-sqft');
    const latEl      = document.getElementById('modal-lat');
    const lngEl      = document.getElementById('modal-lng');
    const title    = titleEl.value.trim();
    const location = locationEl.value.trim();
    const price    = parseFloat(priceEl.value) || 0;
    const intent   = intentEl.value;
    const type     = typeEl.value;
    const status   = statusEl.value;
    const beds     = parseInt(bedsEl.value) || 0;
    const baths    = parseFloat(bathsEl.value) || 0;
    const sqft     = parseInt(sqftEl.value) || 0;
    const views    = parseInt(document.getElementById('modal-views').value) || 0;
    const lat      = parseFloat(latEl.value) || null;
    const lng      = parseFloat(lngEl.value) || null;
    // Compute cover image from uploadedMedia (first image marked as cover, or placeholder if no images)
    const coverItem = uploadedMedia.find(m => m.is_cover && m.media_type === 'image');
    const firstImage = uploadedMedia.find(m => m.media_type === 'image');
    const img = coverItem ? coverItem.url : (firstImage ? firstImage.url : MEDIA_PLACEHOLDER);

    // Reset styles
    [titleEl, locationEl, priceEl, intentEl, typeEl, statusEl, bedsEl, bathsEl, sqftEl, latEl, lngEl].forEach(el => {
        if (el) {
            el.classList.remove('border-red-500', 'ring-2', 'ring-red-100');
            el.classList.add('border-outline-variant');
        }
    });

    let hasErrors = false;
    function markInvalid(el) {
        if (el) {
            el.classList.remove('border-outline-variant');
            el.classList.add('border-red-500', 'ring-2', 'ring-red-100');
            hasErrors = true;
        }
    }

    if (title === '') markInvalid(titleEl);
    if (location === '') markInvalid(locationEl);
    // Media is optional — no image required validation
    if (priceEl.value.trim() === '' || price <= 0) markInvalid(priceEl);
    if (intent === '') markInvalid(intentEl);
    if (type === '') markInvalid(typeEl);
    if (status === '') markInvalid(statusEl);
    if (bedsEl.value.trim() === '' || beds < 0) markInvalid(bedsEl);
    if (bathsEl.value.trim() === '' || baths < 0) markInvalid(bathsEl);
    if (sqftEl.value.trim() === '' || sqft <= 0) markInvalid(sqftEl);
    if (latEl.value.trim() === '' || isNaN(lat) || lat < -90 || lat > 90) markInvalid(latEl);
    if (lngEl.value.trim() === '' || isNaN(lng) || lng < -180 || lng > 180) markInvalid(lngEl);

    let profanityFound = false;
    if (window.hasProfanity && (window.hasProfanity(title) || window.hasProfanity(location))) {
        profanityFound = true;
        if (window.hasProfanity(title)) markInvalid(titleEl);
        if (window.hasProfanity(location)) markInvalid(locationEl);
    }

    const errorBanner = document.getElementById('modal-validation-error');
    if (profanityFound) {
        if (errorBanner) {
            const textSpan = errorBanner.querySelector('span:last-child');
            if (textSpan) textSpan.textContent = 'WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.';
            errorBanner.classList.remove('hidden');
            errorBanner.classList.add('flex');
            errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        showToast('WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.', 'profanity');
        return;
    }

    if (hasErrors) {
        if (errorBanner) {
            const textSpan = errorBanner.querySelector('span:last-child');
            if (textSpan) textSpan.textContent = 'Please fill in all fields with valid information before saving.';
            errorBanner.classList.remove('hidden');
            errorBanner.classList.add('flex');
            errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        showToast('Please correct the highlighted fields before saving.');
        return;
    } else {
        if (errorBanner) {
            errorBanner.classList.add('hidden');
            errorBanner.classList.remove('flex');
        }
    }

    const { data: { user } } = await supabase.auth.getUser();
    
    // Retrieve old status if this is an update
    let oldStatus = null;
    if (id) {
        const { data: oldListing } = await supabase.from('listings').select('status').eq('id', id).single();
        if (oldListing) oldStatus = oldListing.status;
    }

    const listingData = { 
        title, location, price, intent, type, status, beds, baths, sqft, views, lat, lng, img,
        broker_id: user ? user.id : null
    };

    let result;
    if (id) {
        result = await supabase.from('listings').update(listingData).eq('id', id);
    } else {
        result = await supabase.from('listings').insert([listingData]);
    }

    if (result.error) {
        showToast('Error saving listing: ' + result.error.message);
    } else {
        // Resolve listing ID (for inserts we need to fetch the newly created row)
        let resolvedId = id || null;
        if (!id) {
            const { data: newListing } = await supabase
                .from('listings')
                .select('id')
                .eq('broker_id', user ? user.id : null)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            if (newListing) {
                resolvedId = newListing.id;
                await logListingStatusChange(resolvedId, null, status, 'Listing created.');
            }
        } else if (oldStatus !== status) {
            await logListingStatusChange(id, oldStatus, status, 'Status updated by owner.');
        }

        // Save listing media rows to listing_media table
        if (resolvedId) {
            await saveListingMedia(resolvedId, user ? user.id : null);
        }

        await renderListings();
        closeListingModal();

        // Only show share popup for NEW listings (no id means it was an insert)
        if (!id) {
            const newId = resolvedId;

            const shareUrl = newId
                ? `${window.location.origin}/property-details.html?id=${newId}`
                : null;

            // Inject popup
            const overlay = document.createElement('div');
            overlay.id = 'listing-success-overlay';
            overlay.className = 'fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm';
            overlay.innerHTML = `
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8 space-y-6 text-center">
                    <div class="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
                        <span class="material-symbols-outlined text-emerald-600 text-[28px]">check_circle</span>
                    </div>
                    <div>
                        <h3 class="text-xl font-black text-slate-900 tracking-tight">Listing Created!</h3>
                        <p class="text-sm text-slate-500 font-medium mt-1">Your listing <span class="font-black text-slate-900">#${newId || '—'}</span> has been submitted for review.</p>
                    </div>
                    ${shareUrl ? `
                    <div class="space-y-2 text-left">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-400">Shareable Link</label>
                        <div class="flex gap-2">
                            <input 
                                type="text" 
                                value="${shareUrl}" 
                                readonly 
                                id="listing-share-input"
                                class="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-600 outline-none truncate"
                            />
                            <button id="listing-copy-btn" class="px-4 py-3 bg-slate-900 text-white rounded-xl text-xs font-black hover:bg-slate-800 transition-colors active:scale-95 flex items-center gap-1.5">
                                <span class="material-symbols-outlined text-[16px]">content_copy</span>
                                Copy
                            </button>
                        </div>
                    </div>
                    <div class="mt-4 pt-4 border-t border-slate-100 flex items-center justify-center gap-4">
                        <a href="https://api.whatsapp.com/send?text=${encodeURIComponent('Check out this property: ' + shareUrl)}" target="_blank" class="w-10 h-10 rounded-full bg-[#25D366]/10 text-[#25D366] flex items-center justify-center hover:bg-[#25D366]/20 transition-colors" title="Share on WhatsApp">
                            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12.031 0C5.385 0 0 5.385 0 12.031c0 2.127.555 4.195 1.613 6.015L.175 23.364l5.474-1.436c1.758.966 3.743 1.478 5.795 1.478 6.643 0 12.031-5.385 12.031-12.031S18.675 0 12.031 0zm3.844 17.202c-.174.492-.988.948-1.393 1.011-.34.053-.8.113-2.392-.511-1.926-.754-3.16-2.73-3.21-2.798-.052-.066-.766-1.02-.766-1.944 0-.923.483-1.378.653-1.564.168-.184.364-.23.485-.23.123 0 .245.006.353.012.115.005.27-.044.422.324.16.388.544 1.328.594 1.428.05.101.084.218.017.35-.067.133-.102.215-.203.334-.1.118-.21.258-.3.354-.102.108-.207.228-.09.431.115.203.513.85 1.101 1.377.758.681 1.402.893 1.603.993.203.102.321.084.441-.053.118-.135.513-.598.651-.803.138-.204.275-.17.46-.102.185.068 1.171.552 1.371.652.203.1.338.153.388.236.05.084.05.485-.124.977z"/></svg>
                        </a>
                        <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}" target="_blank" class="w-10 h-10 rounded-full bg-[#1877F2]/10 text-[#1877F2] flex items-center justify-center hover:bg-[#1877F2]/20 transition-colors" title="Share on Facebook">
                            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.469h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                        </a>
                        <a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent('Check out this amazing property listing!')}" target="_blank" class="w-10 h-10 rounded-full bg-[#1DA1F2]/10 text-[#1DA1F2] flex items-center justify-center hover:bg-[#1DA1F2]/20 transition-colors" title="Share on X (Twitter)">
                            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 22.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.005 4.15H5.059z"/></svg>
                        </a>
                        <a href="mailto:?subject=Check out this property listing&body=${encodeURIComponent('Here is a great property listing I thought you might like: ' + shareUrl)}" class="w-10 h-10 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center hover:bg-slate-200 transition-colors" title="Share via Email">
                            <span class="material-symbols-outlined text-[20px]">mail</span>
                        </a>
                    </div>
                    ` : ''}
                    <button id="listing-success-close" class="w-full bg-slate-900 text-white py-3.5 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-colors active:scale-[0.98]">
                        Done
                    </button>
                </div>
            `;
            document.body.appendChild(overlay);

            // Copy button
            const copyBtn = overlay.querySelector('#listing-copy-btn');
            if (copyBtn) {
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(shareUrl).then(() => {
                        copyBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">check</span> Copied!';
                        copyBtn.classList.replace('bg-slate-900', 'bg-emerald-600');
                        setTimeout(() => {
                            copyBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">content_copy</span> Copy';
                            copyBtn.classList.replace('bg-emerald-600', 'bg-slate-900');
                        }, 2000);
                    });
                });
            }

            // Close button and backdrop
            const closePopup = () => overlay.remove();
            const closeBtn = overlay.querySelector('#listing-success-close');
            if (closeBtn) closeBtn.addEventListener('click', closePopup);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) closePopup(); });
        } else {
            showToast('Listing updated successfully.');
        }
    }
}

window.saveListingForm = saveListingForm;

// ══════════════════════════════════════════════════════
//  LISTING MEDIA HELPERS
// ══════════════════════════════════════════════════════

const MEDIA_PLACEHOLDER = 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80';

function renderMediaGrid() {
    const grid = document.getElementById('modal-media-grid');
    if (!grid) return;
    if (uploadedMedia.length === 0) {
        grid.innerHTML = '';
        grid.classList.add('hidden');
        const zone = document.getElementById('modal-upload-zone');
        if (zone) zone.classList.remove('hidden');
        return;
    }
    const zone = document.getElementById('modal-upload-zone');
    if (zone) zone.classList.remove('hidden');
    grid.classList.remove('hidden');
    grid.innerHTML = uploadedMedia.map((item, idx) => {
        const isImage = item.media_type === 'image';
        const isCover = item.is_cover;
        const thumbHtml = isImage
            ? `<img src="${escHtml(item.url)}" class="w-full h-full object-cover" alt="Media ${idx+1}">`
            : `<div class="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-white gap-1">
                <span class="material-symbols-outlined text-[28px] text-slate-300">play_circle</span>
                <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Video</span>
               </div>`;
        const coverBadge = isCover
            ? `<span class="absolute top-1.5 left-1.5 bg-primary text-on-primary text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full">Cover</span>`
            : '';
        const setCoverBtn = isImage && !isCover
            ? `<button type="button" onclick="setCoverItem(${idx})" title="Set as Cover" class="p-1 bg-white/90 hover:bg-white rounded text-slate-700 transition-colors"><span class="material-symbols-outlined text-[14px]">star</span></button>`
            : '';
        return `
        <div class="relative rounded-lg overflow-hidden border-2 ${isCover ? 'border-primary' : 'border-outline-variant'} bg-slate-100 aspect-[4/3]">
            ${thumbHtml}
            ${coverBadge}
            <div class="absolute inset-0 bg-black/0 hover:bg-black/40 transition-all flex items-end justify-center pb-2 gap-1 opacity-0 hover:opacity-100">
                <button type="button" onclick="moveMediaItem(${idx},-1)" title="Move Left" class="p-1 bg-white/90 hover:bg-white rounded text-slate-700 transition-colors ${idx === 0 ? 'opacity-30 pointer-events-none' : ''}"><span class="material-symbols-outlined text-[14px]">arrow_back</span></button>
                ${setCoverBtn}
                <button type="button" onclick="removeMediaItem(${idx})" title="Remove" class="p-1 bg-red-600 hover:bg-red-700 rounded text-white transition-colors"><span class="material-symbols-outlined text-[14px]">delete</span></button>
                <button type="button" onclick="moveMediaItem(${idx},1)" title="Move Right" class="p-1 bg-white/90 hover:bg-white rounded text-slate-700 transition-colors ${idx === uploadedMedia.length-1 ? 'opacity-30 pointer-events-none' : ''}"><span class="material-symbols-outlined text-[14px]">arrow_forward</span></button>
            </div>
            <span class="absolute bottom-1 right-1 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full ${isImage ? 'bg-slate-900/70 text-white' : 'bg-blue-600/90 text-white'}">${isImage ? 'IMG' : 'VID'}</span>
        </div>`;
    }).join('');
}

window.removeMediaItem = function(idx) {
    const wasCover = uploadedMedia[idx]?.is_cover;
    uploadedMedia.splice(idx, 1);
    if (wasCover && uploadedMedia.length > 0) {
        const firstImg = uploadedMedia.find(m => m.media_type === 'image');
        if (firstImg) firstImg.is_cover = true;
    }
    renderMediaGrid();
};

window.setCoverItem = function(idx) {
    uploadedMedia.forEach((m, i) => { m.is_cover = (i === idx); });
    renderMediaGrid();
};

window.moveMediaItem = function(idx, dir) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= uploadedMedia.length) return;
    [uploadedMedia[idx], uploadedMedia[newIdx]] = [uploadedMedia[newIdx], uploadedMedia[idx]];
    renderMediaGrid();
};

async function handleMultipleUploads(files, listingIdHint) {
    const progressEl = document.getElementById('modal-upload-progress');
    const uploadZone = document.getElementById('modal-upload-zone');
    if (progressEl) progressEl.classList.remove('hidden');
    if (uploadZone) uploadZone.classList.add('opacity-50', 'pointer-events-none');

    const folderName = listingIdHint ? `listing-media/${listingIdHint}` : `listing-media/temp-${Date.now()}`;

    for (const file of files) {
        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');
        if (!isImage && !isVideo) {
            showToast(`Skipped unsupported file: ${file.name}`);
            continue;
        }
        try {
            const ext = file.name.split('.').pop().toLowerCase();
            const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = `${folderName}/${Date.now()}-${safeBase}`;
            const { error: upErr } = await supabase.storage
                .from('properties')
                .upload(filePath, file, { cacheControl: '3600', upsert: true });
            if (upErr) throw upErr;
            const { data: { publicUrl } } = supabase.storage.from('properties').getPublicUrl(filePath);
            const hasNoCoverImage = !uploadedMedia.some(m => m.is_cover && m.media_type === 'image');
            uploadedMedia.push({
                url: publicUrl,
                media_type: isImage ? 'image' : 'video',
                is_cover: isImage && hasNoCoverImage,
                alt_text: file.name
            });
        } catch (err) {
            showToast(`Failed to upload ${file.name}: ${err.message}`, true);
        }
    }

    if (progressEl) progressEl.classList.add('hidden');
    if (uploadZone) uploadZone.classList.remove('opacity-50', 'pointer-events-none');
    renderMediaGrid();
}

async function saveListingMedia(listingId, brokerId) {
    // Delete existing rows for this listing
    await supabase.from('listing_media').delete().eq('listing_id', listingId);

    if (uploadedMedia.length === 0) return;

    const rows = uploadedMedia.map((item, idx) => ({
        listing_id: listingId,
        broker_id: brokerId,
        media_type: item.media_type,
        url: item.url,
        thumbnail_url: item.thumbnail_url || null,
        sort_order: idx,
        is_cover: item.is_cover || false,
        alt_text: item.alt_text || null
    }));

    const { error } = await supabase.from('listing_media').insert(rows);
    if (error) console.error('Error saving listing_media:', error.message);
}

function renderInteractiveGallery(container, mediaItems, fallbackImg) {
    if (!container) return;
    const PLACEHOLDER = MEDIA_PLACEHOLDER;

    // Build display items with fallback
    let items = mediaItems && mediaItems.length > 0 ? mediaItems : [];
    if (items.length === 0 && fallbackImg) {
        items = [{ url: fallbackImg, media_type: 'image', is_cover: true }];
    }
    if (items.length === 0) {
        items = [{ url: PLACEHOLDER, media_type: 'image', is_cover: true }];
    }

    let activeIdx = 0;

    function buildHtml() {
        const item = items[activeIdx];
        const isVideo = item.media_type === 'video';
        const mainMediaHtml = isVideo
            ? `<video src="${escHtml(item.url)}" controls playsinline class="w-full h-full object-contain bg-black"></video>`
            : `<img src="${escHtml(item.url)}" alt="Property media ${activeIdx + 1}" class="w-full h-full object-cover transition-all duration-500">`;

        const thumbsHtml = items.length > 1 ? `
        <div class="flex gap-2 overflow-x-auto py-2 px-1 mt-3 scrollbar-hide">
            ${items.map((m, i) => {
                const thumbIsVideo = m.media_type === 'video';
                const thumbContent = thumbIsVideo
                    ? `<div class="w-full h-full flex items-center justify-center bg-slate-900"><span class="material-symbols-outlined text-white text-[20px]">play_circle</span></div>`
                    : `<img src="${escHtml(m.url)}" class="w-full h-full object-cover" alt="Thumb ${i+1}">`;
                return `<button type="button" data-idx="${i}" class="gallery-thumb shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all ${i === activeIdx ? 'border-slate-900 scale-105' : 'border-transparent opacity-60 hover:opacity-100'}">${thumbContent}</button>`;
            }).join('')}
        </div>` : '';

        const counter = items.length > 1 ? `<span class="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs font-bold px-3 py-1 rounded-full">${activeIdx + 1} / ${items.length}</span>` : '';
        const prevBtn = items.length > 1 && activeIdx > 0 ? `<button type="button" id="gallery-prev" class="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center bg-white/80 hover:bg-white rounded-full shadow-lg transition-all"><span class="material-symbols-outlined text-slate-800 text-[20px]">arrow_back</span></button>` : '';
        const nextBtn = items.length > 1 && activeIdx < items.length - 1 ? `<button type="button" id="gallery-next" class="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center bg-white/80 hover:bg-white rounded-full shadow-lg transition-all"><span class="material-symbols-outlined text-slate-800 text-[20px]">arrow_forward</span></button>` : '';

        container.innerHTML = `
        <div class="w-full">
            <div class="h-[400px] md:h-[580px] w-full rounded-[32px] overflow-hidden relative shadow-2xl bg-slate-100">
                ${mainMediaHtml}
                ${prevBtn}
                ${nextBtn}
                ${counter}
            </div>
            ${thumbsHtml}
        </div>`;

        // Wire up events
        const prevEl = container.querySelector('#gallery-prev');
        const nextEl = container.querySelector('#gallery-next');
        if (prevEl) prevEl.onclick = () => { activeIdx--; buildHtml(); };
        if (nextEl) nextEl.onclick = () => { activeIdx++; buildHtml(); };
        container.querySelectorAll('.gallery-thumb').forEach(btn => {
            btn.onclick = () => { activeIdx = parseInt(btn.dataset.idx); buildHtml(); };
        });
    }

    buildHtml();
}

function injectListingModal() {
    if (document.getElementById('listing-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'listing-modal';
    modal.className = 'hidden fixed inset-0 z-[100] items-center justify-center bg-black/50 backdrop-blur-sm';
    modal.innerHTML = `
      <div class="bg-surface-container-lowest rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden border border-outline-variant">
        <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant bg-surface-container-low">
          <h3 id="modal-title" class="font-h3 text-h3 text-primary">Add New Listing</h3>
          <button onclick="closeListingModal()" class="text-slate-400 hover:text-slate-700 transition-colors">
            <span class="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
        <div class="p-6 overflow-y-auto max-h-[70vh]">
          <div id="modal-validation-error" class="hidden mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs font-medium flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px]">warning</span>
            <span>Please fill in all fields with valid information before saving.</span>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input type="hidden" id="modal-id"/>
            <input type="hidden" id="modal-views"/>
            <div class="md:col-span-2">
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Property Title *</label>
              <input id="modal-prop-title" type="text" placeholder="e.g. 12 Marine Drive, Penthouse" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
            </div>
            <div class="md:col-span-2 relative">
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Location *</label>
              <div class="relative">
                <input id="modal-location" type="text" autocomplete="off" placeholder="e.g. Bandra West, Mumbai" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
                <div id="modal-location-results" class="absolute left-0 right-0 mt-1 bg-surface-container-lowest rounded-lg shadow-xl border border-outline-variant hidden flex-col max-h-60 overflow-y-auto z-50"></div>
              </div>
            </div>
            <div class="md:col-span-2">
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Property Media <span class="text-slate-400 font-normal normal-case">(Images &amp; Videos — optional)</span></label>
              <div id="modal-media-grid" class="hidden grid grid-cols-3 gap-2 mb-2"></div>
              <div id="modal-upload-zone" class="border-2 border-dashed border-slate-200 rounded-xl p-5 text-center cursor-pointer hover:border-primary hover:bg-slate-50/50 transition-all flex flex-col items-center justify-center gap-2 bg-surface-container-low">
                <span class="material-symbols-outlined text-[28px] text-slate-400">perm_media</span>
                <p class="text-sm font-medium text-slate-600">Drag &amp; drop images or videos, or <span class="text-primary font-bold">browse</span></p>
                <p class="text-xs text-slate-400">Supports PNG, JPG, JPEG, MP4, MOV, WEBM — multiple files allowed</p>
              </div>
              <input type="file" id="modal-file-input" class="hidden" accept="image/*,video/*" multiple />
              <div id="modal-upload-progress" class="hidden w-full bg-slate-100 rounded-full h-1.5 mt-2 overflow-hidden">
                <div class="bg-primary h-1.5 rounded-full animate-pulse" style="width: 100%"></div>
              </div>
              <input type="hidden" id="modal-img" />
            </div>
            <div>

              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Price *</label>
              <div class="flex gap-2">
                <input id="modal-price-display" type="number" step="0.01" placeholder="e.g. 45" 
                  class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
                <select id="modal-price-unit" 
                  class="bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
                  <option value="cr">Cr</option>
                  <option value="lac">Lac</option>
                  <option value="k">/mo (₹)</option>
                </select>
              </div>
              <input type="hidden" id="modal-price" />
              <p id="modal-price-preview" class="text-[10px] text-slate-400 font-medium mt-1"></p>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Intent *</label>
              <select id="modal-intent" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
                <option value="Buy">Buy</option>
                <option value="Rent">Rent</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Property Type *</label>
              <select id="modal-type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
                <option value="Apartment">Apartment</option>
                <option value="Villa">Villa</option>
                <option value="Penthouse">Penthouse</option>
                <option value="Office">Office</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Status *</label>
              <select id="modal-status" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
              </select>
              ${userRole === 'Broker' ? '<p class="text-[10px] text-amber-600 font-semibold mt-1">Note: All new/edited listings require employee approval before going Active.</p>' : ''}
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Bedrooms *</label>
              <input id="modal-beds" type="number" placeholder="0" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed"/>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Bathrooms *</label>
              <input id="modal-baths" type="number" step="0.5" placeholder="0" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed"/>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">SqFt *</label>
              <input id="modal-sqft" type="number" placeholder="0" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed"/>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Latitude *</label>
              <input id="modal-lat" type="number" step="any" placeholder="19.0760" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed"/>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Longitude *</label>
              <input id="modal-lng" type="number" step="any" placeholder="72.8777" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed"/>
            </div>
          </div>
        </div>
        <div class="px-6 py-4 bg-surface-container-low border-t border-outline-variant flex justify-end gap-3">
          <button onclick="closeListingModal()" class="px-5 py-2 rounded-lg border border-outline-variant text-on-surface-variant text-sm font-medium hover:bg-surface-container transition-colors">Cancel</button>
          <button onclick="saveListingForm()" class="px-5 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium hover:opacity-90 transition-opacity">Save Listing</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeListingModal(); });

    // Price auto-converter
    const priceDisplay = document.getElementById('modal-price-display');
    const priceUnit = document.getElementById('modal-price-unit');
    const priceHidden = document.getElementById('modal-price');
    const pricePreview = document.getElementById('modal-price-preview');

    function convertPrice() {
      const val = parseFloat(priceDisplay.value);
      if (isNaN(val)) {
        priceHidden.value = '';
        pricePreview.textContent = '';
        return;
      }
      const unit = priceUnit.value;
      let crores;
      let preview;
      if (unit === 'cr') {
        crores = val;
        preview = `₹${val} Crore${val !== 1 ? 's' : ''}`;
      } else if (unit === 'lac') {
        crores = val / 100;
        preview = `₹${val} Lac = ₹${crores.toFixed(4)} Cr stored`;
      } else if (unit === 'k') {
        // Per month in rupees → convert to Crores
        crores = val / 10000000;
        const display = val >= 100000 
          ? `₹${(val/100000).toFixed(2)} Lac/mo`
          : `₹${val.toLocaleString('en-IN')}/mo`;
        preview = `${display} = ₹${crores.toFixed(7)} Cr stored`;
      }
      priceHidden.value = crores;
      pricePreview.textContent = `→ ${preview}`;
    }

    priceDisplay.addEventListener('input', convertPrice);
    priceUnit.addEventListener('change', convertPrice);

    // Also sync unit with intent selector
    const intentSelect = document.getElementById('modal-intent');
    if (intentSelect) {
      intentSelect.addEventListener('change', () => {
        if (intentSelect.value === 'Rent') {
          priceUnit.value = 'lac';
        } else {
          priceUnit.value = 'cr';
        }
        convertPrice();
      });
    }

    // Multi-media upload event listeners
    const uploadZone = document.getElementById('modal-upload-zone');
    const fileInput = document.getElementById('modal-file-input');

    if (uploadZone && fileInput) {
        uploadZone.onclick = () => fileInput.click();

        uploadZone.ondragover = (e) => {
            e.preventDefault();
            uploadZone.classList.add('border-primary', 'bg-slate-50');
        };

        uploadZone.ondragleave = () => {
            uploadZone.classList.remove('border-primary', 'bg-slate-50');
        };

        uploadZone.ondrop = (e) => {
            e.preventDefault();
            uploadZone.classList.remove('border-primary', 'bg-slate-50');
            const files = Array.from(e.dataTransfer.files);
            if (files.length) handleMultipleUploads(files, document.getElementById('modal-id')?.value || null);
        };

        fileInput.onchange = (e) => {
            const files = Array.from(e.target.files);
            if (files.length) handleMultipleUploads(files, document.getElementById('modal-id')?.value || null);
            fileInput.value = '';
        };
    }

    // Location Autocomplete with OpenStreetMap (Nominatim)

    const modalLocationInput = document.getElementById('modal-location');
    const modalLocationResults = document.getElementById('modal-location-results');

    if (modalLocationInput && modalLocationResults) {
        let debounceTimer;
        modalLocationInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            const query = e.target.value.trim();
            if (query.length < 3) {
                modalLocationResults.innerHTML = '';
                modalLocationResults.classList.add('hidden');
                modalLocationResults.classList.remove('flex');
                return;
            }
            debounceTimer = setTimeout(() => {
                fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=IN&limit=5`)
                    .then(res => res.json())
                    .then(data => {
                        modalLocationResults.innerHTML = '';
                        if (data.length === 0) {
                            modalLocationResults.innerHTML = '<div class="p-4 text-sm text-slate-500 font-medium bg-surface-container-lowest text-on-surface">No locations found.</div>';
                        } else {
                            data.forEach(item => {
                                const div = document.createElement('div');
                                div.className = 'px-4 py-2.5 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0 transition-colors flex items-center gap-3 bg-white text-slate-700 text-left';
                                div.innerHTML = `
                                    <span class="material-symbols-outlined text-slate-400 text-[18px] shrink-0">location_on</span>
                                    <div class="flex flex-col min-w-0">
                                        <span class="text-sm font-semibold truncate text-slate-800">${item.display_name.split(',')[0]}</span>
                                        <span class="text-[10px] text-slate-400 truncate">${item.display_name}</span>
                                    </div>
                                `;
                                div.onclick = () => {
                                    const parts = item.display_name.split(',');
                                    const formattedLocation = parts.slice(0, 3).map(s => s.trim()).join(', ');
                                    modalLocationInput.value = formattedLocation;
                                    
                                    const latEl = document.getElementById('modal-lat');
                                    const lngEl = document.getElementById('modal-lng');
                                    if (latEl) latEl.value = item.lat;
                                    if (lngEl) lngEl.value = item.lon;

                                    modalLocationResults.innerHTML = '';
                                    modalLocationResults.classList.add('hidden');
                                    modalLocationResults.classList.remove('flex');
                                };
                                modalLocationResults.appendChild(div);
                            });
                        }
                        modalLocationResults.classList.remove('hidden');
                        modalLocationResults.classList.add('flex');
                    })
                    .catch(err => {
                        console.error('Error fetching locations:', err);
                    });
            }, 300);
        });

        // Hide results when clicking outside
        document.addEventListener('click', (e) => {
            if (!modalLocationInput.contains(e.target) && !modalLocationResults.contains(e.target)) {
                modalLocationResults.innerHTML = '';
                modalLocationResults.classList.add('hidden');
                modalLocationResults.classList.remove('flex');
            }
        });
    }
}

// ══════════════════════════════════════════════════════
//  BROKER INQUIRIES MANAGER
// ══════════════════════════════════════════════════════

async function getInquiries() {
    const { data, error } = await supabase.from('inquiries').select('*').order('created_at', { ascending: false });
    if (error) {
        console.error('Error fetching inquiries:', error);
        return [];
    }
    return data;
}

async function initInquiriesManager() {
    await renderInquiries();
    injectInquiryModal();
}

async function renderInquiries() {
    const { data: { user } } = await supabase.auth.getUser();
    let inquiries = await getInquiries();
    
    // Filter inquiries so the broker only sees and manages their own inquiries
    if (user) {
        inquiries = inquiries.filter(i => i.broker_id === user.id);
    }
    
    // Dynamically update total leads stats card
    const contactsEl = document.getElementById('stat-new-contacts');
    if (contactsEl) {
        contactsEl.textContent = inquiries.length.toLocaleString();
    }
    
    // Update KPI trend badge for leads
    updateTrendBadge(inquiries, 'stat-leads-trend', 'created_at');

    const unreadCount = inquiries.filter(i => !i.read).length;
    const badge = document.getElementById('new-inquiries-badge');
    
    if (badge) {
        if (unreadCount > 0) {
            badge.textContent = `${unreadCount} New`;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    const html = inquiries.length ? inquiries.map(i => `
        <div onclick="openInquiry(${i.id})" class="p-3 hover:bg-surface-container rounded-lg cursor-pointer transition-colors border-b border-surface-variant last:border-0 relative ${!i.read ? 'bg-primary-fixed/5' : ''}">
          ${!i.read ? '<div class="absolute left-2 top-4 w-2 h-2 rounded-full bg-primary animate-pulse"></div>' : ''}
          <div class="ml-4">
            <div class="flex justify-between items-start mb-1">
              <h4 class="font-body-md text-body-md ${!i.read ? 'font-bold' : 'font-semibold'} text-primary">${escHtml(i.name)}</h4>
              <span class="text-xs text-on-surface-variant">${new Date(i.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant truncate mb-2">${escHtml(i.message)}</p>
            ${i.broker_reply ? `<p class="font-body-sm text-[12px] text-secondary truncate mb-2">Broker: ${escHtml(i.broker_reply)}</p>` : ''}
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold uppercase tracking-wider ${i.type === 'Offer Intent' ? 'bg-secondary-fixed text-on-secondary-fixed-variant' : 'bg-surface-container text-on-surface-variant'} px-1.5 py-0.5 rounded">${i.type}</span>
            </div>
          </div>
        </div>
    `).join('') : '<div class="p-8 text-center text-slate-400 text-sm">No inquiries yet.</div>';
    
    const listWidget = document.getElementById('inquiries-list-widget');
    if (listWidget) listWidget.innerHTML = html;
    const listFull = document.getElementById('inquiries-list-full');
    if (listFull) listFull.innerHTML = html;
}

async function openInquiry(id) {
    const { data: inquiry, error } = await supabase.from('inquiries').select('*').eq('id', id).single();
    if (error || !inquiry) return;

    if (!inquiry.read) {
        await supabase.from('inquiries').update({ read: true }).eq('id', id);
        await renderInquiries();
    }

    const modal = document.getElementById('inquiry-details-modal');
    document.getElementById('inquiry-modal-name').textContent = inquiry.name;
    document.getElementById('inquiry-modal-type').textContent = inquiry.type;
    document.getElementById('inquiry-modal-message').textContent = inquiry.message;
    document.getElementById('inquiry-modal-time').textContent = new Date(inquiry.created_at).toLocaleTimeString();
    document.getElementById('inquiry-modal-reply').value = inquiry.broker_reply || '';
    activeInquiryId = id;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

window.openInquiry = openInquiry;

function closeInquiryModal() {
    const modal = document.getElementById('inquiry-details-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

window.closeInquiryModal = closeInquiryModal;

function injectInquiryModal() {
    if (document.getElementById('inquiry-details-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'inquiry-details-modal';
    modal.className = 'hidden fixed inset-0 z-[100] items-center justify-center bg-black/50 backdrop-blur-sm';
    modal.innerHTML = `
      <div class="bg-surface-container-lowest rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-outline-variant">
        <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant bg-surface-container-low">
          <h3 class="font-h3 text-h3 text-primary">Inquiry Details</h3>
          <button onclick="closeInquiryModal()" class="text-slate-400 hover:text-slate-700 transition-colors">
            <span class="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
        <div class="p-6 space-y-4">
          <div class="flex justify-between items-start">
            <div>
              <h4 id="inquiry-modal-name" class="text-xl font-bold text-primary">Sarah Jenkins</h4>
              <p id="inquiry-modal-type" class="text-xs font-bold uppercase tracking-widest text-on-surface-variant mt-1">Viewing Request</p>
            </div>
            <span id="inquiry-modal-time" class="text-xs text-slate-400">10:42 AM</span>
          </div>
          <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant">
            <p id="inquiry-modal-message" class="text-sm text-slate-700 leading-relaxed italic">"Interested in viewing 123 Luxury Lane this weekend if possible."</p>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Reply Message</label>
            <textarea id="inquiry-modal-reply" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed" rows="3" placeholder="Type broker reply..."></textarea>
          </div>
          <div class="flex flex-col gap-2 pt-2">
            <button id="reply-inquiry-btn" class="w-full bg-primary text-on-primary py-2.5 rounded-lg font-semibold hover:opacity-90 transition-opacity">Send Reply</button>
            <button id="schedule-viewing-btn" class="w-full border border-outline-variant text-on-surface-variant py-2.5 rounded-lg font-semibold hover:bg-surface-container transition-colors">Schedule Viewing</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeInquiryModal(); });

    // Allow Ctrl+Enter on the reply textarea to send
    const replyTextarea = document.getElementById('inquiry-modal-reply');
    if (replyTextarea) {
        replyTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                document.getElementById('reply-inquiry-btn')?.click();
            }
        });
    }

    const replyBtn = document.getElementById('reply-inquiry-btn');
    if (replyBtn) {
        replyBtn.addEventListener('click', async () => {
            const reply = document.getElementById('inquiry-modal-reply')?.value?.trim();
            if (!activeInquiryId || !reply) {
                showToast('Please enter a reply message.');
                return;
            }
            if (window.hasProfanity && window.hasProfanity(reply)) {
                showToast('WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.', 'profanity');
                return;
            }
            const { error } = await supabase.from('inquiries').update({ broker_reply: reply, read: true }).eq('id', activeInquiryId);
            if (error) {
                showToast('Error sending reply: ' + error.message);
            } else {
                await renderInquiries();
                showToast('Reply sent to buyer.');
            }
        });
    }

    const scheduleBtn = document.getElementById('schedule-viewing-btn');
    if (scheduleBtn) {
        scheduleBtn.addEventListener('click', () => {
            showToast('Viewing request marked for scheduling.');
        });
    }
}

// ══════════════════════════════════════════════════════
//  BROKER CUSTOM FILTERS MANAGER (Supabase-based CRUD)
// ══════════════════════════════════════════════════════

let editFilterId = null;
let modalMap = null;
let modalMarker = null;

async function initCustomFiltersManager() {
    await renderCustomFilters();
    injectCustomFilterModal();
}

async function renderCustomFilters() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const tbody = document.getElementById('custom-filters-tbody');
    if (!tbody) return;

    const { data: filters, error } = await supabase
        .from('custom_filters')
        .select('*')
        .eq('broker_id', user.id)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error fetching custom filters:', error);
        tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-slate-400">Error loading custom filters.</td></tr>';
        return;
    }

    if (!filters || filters.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-slate-400 font-medium">No custom filters saved. Create one to share tailored lists with clients.</td></tr>';
        return;
    }

    tbody.innerHTML = filters.map(f => {
        const crit = f.criteria || {};
        const parts = [];
        if (crit.centerLabel) {
            const radStr = crit.radius ? ` (${crit.radius >= 1000 ? (crit.radius/1000).toFixed(1) + 'km' : crit.radius + 'm'})` : '';
            parts.push(`Near: ${escHtml(crit.centerLabel)}${radStr}`);
        }
        if (crit.type && crit.type !== 'Any') parts.push(`Type: ${crit.type}`);
        if (crit.intent && crit.intent !== 'Any') parts.push(`Intent: ${crit.intent}`);
        
        if (crit.bedsMin || crit.bedsMax) {
            const minB = crit.bedsMin || '1';
            const maxB = crit.bedsMax || '5+';
            parts.push(`Beds: ${minB}-${maxB}`);
        }
        if (crit.priceMin || crit.priceMax) {
            const minP = crit.priceMin ? `₹${crit.priceMin}Cr` : '0';
            const maxP = crit.priceMax ? `₹${crit.priceMax}Cr` : '∞';
            parts.push(`Price: ${minP}-${maxP}`);
        }
        if (crit.sqftMin || crit.sqftMax) {
            const minS = crit.sqftMin ? `${crit.sqftMin}` : '0';
            const maxS = crit.sqftMax ? `${crit.sqftMax}` : '∞';
            parts.push(`Area: ${minS}-${maxS}sqft`);
        }

        const criteriaStr = parts.join(' | ') || 'All Active Inventory';
        const visibilityBadge = f.is_public !== false 
            ? '<span class="ml-2 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 rounded border border-emerald-200">Public</span>'
            : '<span class="ml-2 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider bg-amber-50 text-amber-700 rounded border border-amber-200">Private</span>';

        return `
        <tr class="border-b border-surface-variant hover:bg-surface-container transition-colors" data-filter-id="${f.id}">
          <td class="p-4 font-semibold text-primary">
            <div class="flex items-center">
              ${escHtml(f.name)}
              ${visibilityBadge}
            </div>
          </td>
          <td class="p-4 text-on-surface-variant text-xs">${criteriaStr}</td>
          <td class="p-4 text-right">
            <div class="flex justify-end gap-2">
              <button onclick="openCustomFilterModal(${f.id})" class="p-1.5 text-on-surface-variant hover:text-primary rounded hover:bg-surface-container" title="Edit Filter">
                <span class="material-symbols-outlined text-[20px]">edit</span>
              </button>
              <button onclick="copyShareLink(${f.id})" class="p-1.5 text-on-surface-variant hover:text-primary rounded hover:bg-surface-container" title="Copy Shareable Link">
                <span class="material-symbols-outlined text-[20px]">content_copy</span>
              </button>
              <button onclick="testCustomFilter(${f.id})" class="p-1.5 text-on-surface-variant hover:text-primary rounded hover:bg-surface-container" title="Test Filter">
                <span class="material-symbols-outlined text-[20px]">open_in_new</span>
              </button>
              <button onclick="deleteCustomFilter(${f.id})" class="p-1.5 text-on-surface-variant hover:text-error rounded hover:bg-error-container" title="Delete">
                <span class="material-symbols-outlined text-[20px]">delete</span>
              </button>
            </div>
          </td>
        </tr>
        `;
    }).join('');
}

function updateModalLocationCoordinates(lat, lng, doGeocode = false) {
    document.getElementById('filter-center-lat').value = parseFloat(lat).toFixed(6);
    document.getElementById('filter-center-lng').value = parseFloat(lng).toFixed(6);
    if (doGeocode) {
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
            .then(res => res.json())
            .then(data => {
                if (data && data.display_name) {
                    const parts = data.display_name.split(',');
                    const formatted = parts.slice(0, 3).map(p => p.trim()).join(', ');
                    document.getElementById('filter-center-label').value = formatted;
                }
            })
            .catch(err => console.error('Reverse geocoding failed:', err));
    }
}

function initModalLeafletMap(lat, lng) {
    if (typeof L === 'undefined') {
        console.warn('Leaflet map framework not loaded on window');
        return;
    }
    const container = document.getElementById('filter-modal-map');
    if (!container) return;

    if (!modalMap) {
        modalMap = L.map('filter-modal-map').setView([lat, lng], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(modalMap);

        modalMarker = L.marker([lat, lng], { draggable: true }).addTo(modalMap);

        modalMarker.on('dragend', () => {
            const pos = modalMarker.getLatLng();
            updateModalLocationCoordinates(pos.lat, pos.lng, true);
        });

        modalMap.on('click', (e) => {
            modalMarker.setLatLng(e.latlng);
            updateModalLocationCoordinates(e.latlng.lat, e.latlng.lng, true);
        });

        // The container was hidden (display:none) when Leaflet initialised, so it
        // measured 0×0 and rendered blank tiles.  Force a size recalculation once
        // the browser has repainted with the container now visible.
        setTimeout(() => {
            modalMap.invalidateSize();
        }, 150);
    } else {
        modalMap.setView([lat, lng], 13);
        modalMarker.setLatLng([lat, lng]);
        setTimeout(() => {
            modalMap.invalidateSize();
        }, 100);
    }
}

function injectCustomFilterModal() {
    if (document.getElementById('custom-filter-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'custom-filter-modal';
    modal.className = 'hidden fixed inset-0 z-[100] items-center justify-center bg-black/50 backdrop-blur-sm';
    modal.innerHTML = `
      <div class="bg-surface-container-lowest rounded-xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden border border-outline-variant flex flex-col max-h-[90vh]">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant bg-surface-container-low shrink-0">
          <h3 id="filter-modal-title" class="font-h3 text-h3 text-primary">Create Custom Filter</h3>
          <button onclick="closeCustomFilterModal()" class="text-slate-400 hover:text-slate-700 transition-colors">
            <span class="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
        
        <!-- Scrollable Form Content -->
        <div class="p-6 space-y-5 overflow-y-auto flex-1">
          <!-- Filter Name -->
          <div>
            <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Filter Name *</label>
            <input id="filter-name" type="text" placeholder="e.g. Bandra West Curated Properties" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
          </div>

          <!-- Type & Intent -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Property Type</label>
              <select id="filter-type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
                <option value="Any">Any</option>
                <option value="Apartment">Apartment</option>
                <option value="Villa">Villa</option>
                <option value="Penthouse">Penthouse</option>
                <option value="Office">Office</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Intent</label>
              <select id="filter-intent" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
                <option value="Any">Any</option>
                <option value="Buy">Buy</option>
                <option value="Rent">Rent</option>
              </select>
            </div>
          </div>

          <!-- Bedrooms Min / Max -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Bedrooms Min</label>
              <select id="filter-beds-min" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
                <option value="">Any</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Bedrooms Max</label>
              <select id="filter-beds-max" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed">
                <option value="">Any</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5+">5+</option>
              </select>
            </div>
          </div>

          <!-- Price Min / Max -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Price Min (Cr)</label>
              <input id="filter-price-min" type="number" step="0.1" placeholder="Min Price" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Price Max (Cr)</label>
              <input id="filter-price-max" type="number" step="0.1" placeholder="Max Price" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
            </div>
          </div>

          <!-- Sqft Min / Max -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Area Min (sqft)</label>
              <input id="filter-sqft-min" type="number" step="50" placeholder="Min Area" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Area Max (sqft)</label>
              <input id="filter-sqft-max" type="number" step="50" placeholder="Max Area" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
            </div>
          </div>

          <!-- Geospatial Location curation -->
          <div class="border-t border-slate-100 pt-4 space-y-4">
            <h4 class="text-sm font-bold text-slate-800">Geospatial Center & Radius</h4>
            
            <div class="relative">
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Center Location Label *</label>
              <input id="filter-center-label" type="text" placeholder="Search address or neighborhood..." class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-fixed focus:border-transparent"/>
              <div id="filter-location-results" class="absolute left-0 right-0 z-[1050] bg-white rounded-xl shadow-lg border border-slate-200 mt-1 hidden flex-col max-h-48 overflow-y-auto"></div>
            </div>

            <!-- Latitude & Longitude displays -->
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Center Latitude</label>
                <input id="filter-center-lat" type="number" readonly placeholder="Auto geocoded lat" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-500 cursor-not-allowed outline-none"/>
              </div>
              <div>
                <label class="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Center Longitude</label>
                <input id="filter-center-lng" type="number" readonly placeholder="Auto geocoded lng" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-500 cursor-not-allowed outline-none"/>
              </div>
            </div>

            <!-- Quick Geolocation buttons -->
            <div class="flex gap-3">
              <button id="filter-use-location-btn" class="flex-1 py-2 rounded-lg border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-center gap-1.5">
                <span class="material-symbols-outlined text-[16px]">my_location</span>
                Use Current Location
              </button>
              <button id="filter-toggle-map-btn" class="flex-1 py-2 rounded-lg border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-center gap-1.5">
                <span class="material-symbols-outlined text-[16px]">map</span>
                Choose on Map
              </button>
            </div>

            <!-- Leaflet Map Wrapper -->
            <div id="filter-modal-map" class="hidden"></div>

            <!-- Radius slider -->
            <div>
              <div class="flex justify-between items-center mb-1">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Search Radius</label>
                <span id="filter-radius-val" class="text-xs font-black text-slate-900 bg-slate-100 px-2 py-0.5 rounded">1.0 km</span>
              </div>
              <input id="filter-radius" type="range" min="250" max="10000" step="250" value="1000" class="w-full accent-primary h-1.5 bg-slate-200 rounded-lg cursor-pointer mt-2"/>
            </div>
          </div>

          <!-- Public/Private visibility toggle -->
          <div class="border-t border-slate-100 pt-4">
            <label class="flex items-center justify-between bg-surface-container-low border border-outline-variant rounded-lg px-4 py-3 cursor-pointer select-none">
              <div>
                <p class="font-medium text-primary text-sm">Public Visibility</p>
                <p class="text-[11px] text-on-surface-variant">Allow clients with the link to view matching listings. Private filters are restricted to you.</p>
              </div>
              <input type="checkbox" id="filter-is-public" checked class="h-4 w-4 accent-primary" />
            </label>
          </div>

        </div>

        <!-- Footer -->
        <div class="px-6 py-4 bg-surface-container-low border-t border-outline-variant flex justify-end gap-3 shrink-0">
          <button onclick="closeCustomFilterModal()" class="px-5 py-2 rounded-lg border border-outline-variant text-on-surface-variant text-sm font-medium hover:bg-surface-container transition-colors">Cancel</button>
          <button onclick="saveCustomFilter()" class="px-5 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium hover:opacity-90 transition-opacity">Save Filter</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeCustomFilterModal(); });

    // Autocomplete handling for location search
    const labelInput = document.getElementById('filter-center-label');
    const resultsDiv = document.getElementById('filter-location-results');
    let debounceTimer;

    if (labelInput && resultsDiv) {
        labelInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            const query = e.target.value.trim();
            if (query.length < 3) {
                resultsDiv.innerHTML = '';
                resultsDiv.classList.add('hidden');
                return;
            }
            debounceTimer = setTimeout(() => {
                fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=IN&limit=5`)
                    .then(res => res.json())
                    .then(data => {
                        resultsDiv.innerHTML = '';
                        if (data.length === 0) {
                            resultsDiv.innerHTML = '<div class="p-3 text-xs text-slate-500 font-medium bg-white">No locations found.</div>';
                        } else {
                            data.forEach(item => {
                                const div = document.createElement('div');
                                div.className = 'px-4 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0 transition-colors flex items-center gap-2 text-slate-700 location-result-item';
                                div.innerHTML = `
                                    <span class="material-symbols-outlined text-slate-400 text-[18px]">location_on</span>
                                    <div class="flex flex-col min-w-0">
                                        <span class="text-xs font-semibold truncate text-slate-800">${item.display_name.split(',')[0]}</span>
                                        <span class="text-[9px] text-slate-400 truncate">${item.display_name}</span>
                                    </div>
                                `;
                                div.onclick = () => {
                                    labelInput.value = item.display_name.split(',')[0];
                                    updateModalLocationCoordinates(item.lat, item.lon, false);
                                    resultsDiv.innerHTML = '';
                                    resultsDiv.classList.add('hidden');

                                    // Update map view if open
                                    if (modalMap && modalMarker) {
                                        modalMap.setView([item.lat, item.lon], 15);
                                        modalMarker.setLatLng([item.lat, item.lon]);
                                    }
                                };
                                resultsDiv.appendChild(div);
                            });
                        }
                        resultsDiv.classList.remove('hidden');
                    })
                    .catch(err => console.error('Autocomplete query failed:', err));
            }, 300);
        });

        document.addEventListener('click', (e) => {
            if (!labelInput.contains(e.target) && !resultsDiv.contains(e.target)) {
                resultsDiv.classList.add('hidden');
            }
        });
    }

    // Geolocation button setup
    const useLocBtn = document.getElementById('filter-use-location-btn');
    if (useLocBtn) {
        useLocBtn.onclick = (e) => {
            e.preventDefault();
            if (!navigator.geolocation) {
                showToast('Geolocation is not supported by your browser.', true);
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;
                    updateModalLocationCoordinates(lat, lng, true);
                    
                    if (modalMap && modalMarker) {
                        modalMap.setView([lat, lng], 15);
                        modalMarker.setLatLng([lat, lng]);
                    }
                },
                (err) => {
                    showToast('Failed to fetch location: ' + err.message, true);
                }
            );
        };
    }

    // Leaflet map toggle setup
    const toggleMapBtn = document.getElementById('filter-toggle-map-btn');
    const mapDiv = document.getElementById('filter-modal-map');
    if (toggleMapBtn && mapDiv) {
        toggleMapBtn.onclick = (e) => {
            e.preventDefault();
            const isHidden = mapDiv.classList.contains('hidden');
            if (isHidden) {
                mapDiv.classList.remove('hidden');
                toggleMapBtn.textContent = 'Hide Map';
                
                let lat = parseFloat(document.getElementById('filter-center-lat').value);
                let lng = parseFloat(document.getElementById('filter-center-lng').value);
                if (isNaN(lat) || isNaN(lng)) {
                    lat = 19.0760;
                    lng = 72.8777;
                    updateModalLocationCoordinates(lat, lng, false);
                }
                initModalLeafletMap(lat, lng);
            } else {
                mapDiv.classList.add('hidden');
                toggleMapBtn.textContent = 'Choose on Map';
            }
        };
    }

    // Radius range slider updating text labels
    const radiusSlider = document.getElementById('filter-radius');
    const radiusText = document.getElementById('filter-radius-val');
    if (radiusSlider && radiusText) {
        const updateText = () => {
            const val = parseInt(radiusSlider.value);
            if (val >= 10000) {
                radiusText.textContent = '10.0 km+';
            } else if (val >= 1000) {
                radiusText.textContent = (val / 1000).toFixed(1) + ' km';
            } else {
                radiusText.textContent = val + ' m';
            }
        };
        radiusSlider.addEventListener('input', updateText);
    }
}

window.openCustomFilterModal = async function(id) {
    injectCustomFilterModal();
    const modal = document.getElementById('custom-filter-modal');
    if (!modal) return;

    if (id) {
        // Edit flow
        editFilterId = id;
        document.getElementById('filter-modal-title').textContent = 'Edit Custom Filter';
        
        const { data: filter, error } = await supabase
            .from('custom_filters')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !filter) {
            showToast('Failed to load filter details.', true);
            return;
        }

        document.getElementById('filter-name').value = filter.name || '';
        const crit = filter.criteria || {};
        document.getElementById('filter-type').value = crit.type || 'Any';
        document.getElementById('filter-intent').value = crit.intent || 'Any';
        document.getElementById('filter-beds-min').value = crit.bedsMin || '';
        document.getElementById('filter-beds-max').value = crit.bedsMax || '';
        document.getElementById('filter-price-min').value = crit.priceMin || '';
        document.getElementById('filter-price-max').value = crit.priceMax || '';
        document.getElementById('filter-sqft-min').value = crit.sqftMin || '';
        document.getElementById('filter-sqft-max').value = crit.sqftMax || '';
        document.getElementById('filter-center-label').value = crit.centerLabel || '';
        document.getElementById('filter-center-lat').value = crit.centerLat || '';
        document.getElementById('filter-center-lng').value = crit.centerLng || '';
        
        const radiusSlider = document.getElementById('filter-radius');
        if (radiusSlider) {
            radiusSlider.value = crit.radius || 1000;
            radiusSlider.dispatchEvent(new Event('input'));
        }

        document.getElementById('filter-is-public').checked = filter.is_public !== false;

        // Leaflet map refresh if not hidden
        const mapDiv = document.getElementById('filter-modal-map');
        if (mapDiv && !mapDiv.classList.contains('hidden')) {
            const lat = parseFloat(crit.centerLat);
            const lng = parseFloat(crit.centerLng);
            if (!isNaN(lat) && !isNaN(lng)) {
                initModalLeafletMap(lat, lng);
            }
        }
    } else {
        // Create flow
        editFilterId = null;
        document.getElementById('filter-modal-title').textContent = 'Create Custom Filter';
        
        document.getElementById('filter-name').value = '';
        document.getElementById('filter-type').value = 'Any';
        document.getElementById('filter-intent').value = 'Any';
        document.getElementById('filter-beds-min').value = '';
        document.getElementById('filter-beds-max').value = '';
        document.getElementById('filter-price-min').value = '';
        document.getElementById('filter-price-max').value = '';
        document.getElementById('filter-sqft-min').value = '';
        document.getElementById('filter-sqft-max').value = '';
        document.getElementById('filter-center-label').value = '';
        document.getElementById('filter-center-lat').value = '';
        document.getElementById('filter-center-lng').value = '';
        
        const radiusSlider = document.getElementById('filter-radius');
        if (radiusSlider) {
            radiusSlider.value = 1000;
            radiusSlider.dispatchEvent(new Event('input'));
        }
        document.getElementById('filter-is-public').checked = true;

        const mapDiv = document.getElementById('filter-modal-map');
        if (mapDiv) mapDiv.classList.add('hidden');
        const toggleMapBtn = document.getElementById('filter-toggle-map-btn');
        if (toggleMapBtn) toggleMapBtn.textContent = 'Choose on Map';
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

window.closeCustomFilterModal = function() {
    const modal = document.getElementById('custom-filter-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

async function saveCustomFilter() {
    const name = document.getElementById('filter-name').value.trim();
    const type = document.getElementById('filter-type').value;
    const intent = document.getElementById('filter-intent').value;
    const bedsMin = document.getElementById('filter-beds-min').value;
    const bedsMax = document.getElementById('filter-beds-max').value;
    const priceMin = document.getElementById('filter-price-min').value;
    const priceMax = document.getElementById('filter-price-max').value;
    const sqftMin = document.getElementById('filter-sqft-min').value;
    const sqftMax = document.getElementById('filter-sqft-max').value;
    const centerLabel = document.getElementById('filter-center-label').value.trim();
    const centerLat = document.getElementById('filter-center-lat').value;
    const centerLng = document.getElementById('filter-center-lng').value;
    const radius = document.getElementById('filter-radius').value;
    const is_public = document.getElementById('filter-is-public').checked;

    if (!name) {
        showToast('Please enter a filter name.', true);
        return;
    }
    if (!centerLabel || !centerLat || !centerLng) {
        showToast('Please specify a center location coordinates.', true);
        return;
    }

    if (window.hasProfanity && (window.hasProfanity(name) || window.hasProfanity(centerLabel))) {
        showToast('WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.', 'profanity');
        return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        showToast('Error: No active user session.', true);
        return;
    }

    const filterData = {
        name,
        is_public,
        criteria: {
            type,
            intent,
            bedsMin,
            bedsMax,
            priceMin,
            priceMax,
            sqftMin,
            sqftMax,
            centerLabel,
            centerLat,
            centerLng,
            radius
        }
    };

    let error = null;

    if (editFilterId) {
        // Edit mode - update and preserve slug
        const result = await supabase
            .from('custom_filters')
            .update(filterData)
            .eq('id', editFilterId);
        error = result.error;
    } else {
        // Create mode - insert new unique slug
        const uniqueSlug = Math.random().toString(36).substring(2, 6) + Math.random().toString(36).substring(2, 6);
        filterData.broker_id = user.id;
        filterData.slug = uniqueSlug;

        const result = await supabase
            .from('custom_filters')
            .insert([filterData]);
        error = result.error;
    }

    if (error) {
        // Supabase/PostgREST surfaces a missing column as PGRST204 ("schema cache miss").
        // Raw PostgreSQL code for "column does not exist" is 42703.
        // Detect both so the actionable migration hint fires for either path.
        const isSchemaMissing =
            error.code === 'PGRST204' ||
            error.code === '42703' ||
            (error.message && (
                error.message.toLowerCase().includes('column') ||
                error.message.toLowerCase().includes('schema cache')
            ));
        const msg = isSchemaMissing
            ? 'Database schema is outdated — the custom_filters table is missing required columns (slug, is_public). Please run scripts/migrations/custom_filters_v2.sql in your Supabase SQL Editor, then try again.'
            : 'Error saving filter: ' + error.message;
        showToast(msg, true);
    } else {
        showToast('Custom filter saved successfully.');
        closeCustomFilterModal();
        await renderCustomFilters();
    }
}

async function deleteCustomFilter(filterId) {
    if (!confirm('Are you sure you want to delete this custom filter?')) return;
    const { error } = await supabase.from('custom_filters').delete().eq('id', filterId);
    if (error) {
        showToast('Error deleting filter: ' + error.message, true);
    } else {
        showToast('Custom filter deleted.');
        await renderCustomFilters();
    }
}

async function copyShareLink(filterId) {
    const { data: filter, error } = await supabase
        .from('custom_filters')
        .select('*')
        .eq('id', filterId)
        .single();

    if (error || !filter) {
        showToast('Filter not found.', true);
        return;
    }

    const shareUrl = `${window.location.origin}/shared-filter/${filter.slug}`;

    navigator.clipboard.writeText(shareUrl).then(() => {
        showToast('Shareable link copied to clipboard!');
    }).catch(() => {
        showToast('Failed to copy link.', true);
    });
}

async function testCustomFilter(filterId) {
    const { data: filter, error } = await supabase
        .from('custom_filters')
        .select('*')
        .eq('id', filterId)
        .single();

    if (error || !filter) return;

    const shareUrl = `${window.location.origin}/shared-filter/${filter.slug}`;

    if (window.ajaxLoadPage) {
        window.ajaxLoadPage(shareUrl, false);
    } else {
        window.open(shareUrl, '_blank');
    }
}

window.saveCustomFilter = saveCustomFilter;
window.deleteCustomFilter = deleteCustomFilter;
window.copyShareLink = copyShareLink;
window.testCustomFilter = testCustomFilter;


function initBuyerPageInteractions() {
    wireCommonLinks();

    if (currentPage === 'index.html') {
        initBuyerHomePage();
    } else if (currentPage === 'properties.html') {
        initBuyerListingsPage();
    } else if (currentPage === 'map.html') {
        initBuyerMapPage();
    } else if (currentPage === 'property-details.html') {
        initBuyerDetailsPage();
    } else if (currentPage === 'sell.html') {
        initSellPage();
    }
}

function wireCommonLinks() {
    const navMap = {
        'About Us': 'index.html',
        'Terms of Service': 'terms.html',
        'Privacy Policy': 'privacy.html',
        'Cookie Settings': 'privacy.html',
        'Contact Support': 'login.html',
        'Sitemap': 'sitemap.html'
    };

    document.querySelectorAll('a').forEach((a) => {
        const label = a.textContent.trim();
        if (navMap[label]) a.setAttribute('href', toAppUrl(navMap[label]));
    });
}

function normalizeInternalLinks() {
    document.querySelectorAll('a[href^="/"]').forEach((link) => {
        const href = link.getAttribute('href');
        if (!href || href === '/') {
            link.setAttribute('href', toAppUrl('index.html'));
            return;
        }
        link.setAttribute('href', toAppUrl(href));
    });
}

async function initBuyerHomePage() {
    // ── [Search Bar Navigation] ──
    const searchInput = document.getElementById('location-search');
    const searchBtn = document.getElementById('search-btn');
    const resultsContainer = document.getElementById('search-results');
    let debounceTimer;

    if (searchBtn && searchInput) {
        searchBtn.onclick = () => {
            const val = searchInput.value.trim();
            navigateTo(`map.html${val ? `?q=${encodeURIComponent(val)}` : ''}`);
        };
        searchInput.onkeypress = (e) => { if (e.key === 'Enter') searchBtn.click(); };

        if (resultsContainer) {
            searchInput.addEventListener('input', (e) => {
                clearTimeout(debounceTimer);
                const query = e.target.value.trim();
                if (query.length < 3) { resultsContainer.classList.add('hidden'); return; }
                debounceTimer = setTimeout(() => {
                    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=IN&limit=5`)
                        .then(res => res.json())
                        .then(data => {
                            resultsContainer.innerHTML = '';
                            if (data.length === 0) {
                                resultsContainer.innerHTML = '<div class="p-4 text-sm text-slate-500 font-medium">No locations found.</div>';
                            } else {
                                data.forEach(item => {
                                    const div = document.createElement('div');
                                    div.className = 'px-6 py-4 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0 flex items-center gap-3';
                                    div.innerHTML = `<span class="material-symbols-outlined text-slate-400 text-[20px]">location_on</span><span class="text-sm font-medium text-slate-700 truncate">${item.display_name}</span>`;
                                    div.onclick = () => {
                                        searchInput.value = item.display_name.split(',')[0];
                                        resultsContainer.classList.add('hidden');
                                        navigateTo(`map.html?lat=${item.lat}&lng=${item.lon}&q=${encodeURIComponent(item.display_name)}`);
                                    };
                                    resultsContainer.appendChild(div);
                                });
                            }
                            resultsContainer.classList.remove('hidden');
                            resultsContainer.classList.add('flex');
                        });
                }, 300);
            });
        }
    }

    // ── [Featured Cards from Supabase] ──
    const featuredGrid = document.querySelector('section.py-20 .grid');
    if (featuredGrid) {
        const listings = (await getListings()).filter(l => l.status === 'Active');
        const top3 = listings.slice(0, 3);
        
        if (top3.length > 0) {
            featuredGrid.innerHTML = `
                <!-- Main Featured (2 cols) -->
                <div onclick="window.location.href='property-details.html?id=${top3[0].id}'"
                     class="md:col-span-2 bg-white border border-slate-200 flex flex-col md:flex-row shadow-sm cursor-pointer hover:shadow-lg transition-all">
                  <div class="w-full md:w-1/2 h-64 md:h-auto relative overflow-hidden">
                    <img src="${top3[0].img || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80'}" class="w-full h-full object-cover">
                    <div class="absolute top-4 left-4 bg-emerald-500 text-white px-3 py-1 rounded text-[10px] font-black uppercase tracking-widest">Just Listed</div>
                  </div>
                  <div class="w-full md:w-1/2 p-8 flex flex-col justify-center">
                    <h3 class="text-2xl font-black text-slate-900 mb-2">₹${top3[0].price}${top3[0].intent === 'Rent' ? '' : ' Cr'}</h3>
                    <p class="text-sm font-bold text-slate-500 mb-6">${escHtml(top3[0].title)}, ${escHtml(top3[0].location)}</p>
                    <div class="flex items-center gap-6 pt-6 border-t border-slate-100">
                      <div class="flex items-center gap-2 text-slate-400"><span class="material-symbols-outlined text-[18px]">bed</span><span class="text-xs font-black text-slate-900">${top3[0].beds}</span></div>
                      <div class="flex items-center gap-2 text-slate-400"><span class="material-symbols-outlined text-[18px]">bathtub</span><span class="text-xs font-black text-slate-900">${top3[0].baths}</span></div>
                      <div class="flex items-center gap-2 text-slate-400"><span class="material-symbols-outlined text-[18px]">square_foot</span><span class="text-xs font-black text-slate-900">${(top3[0].sqft || 0).toLocaleString()}</span></div>
                    </div>
                    <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                      <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                        <span class="material-symbols-outlined text-[14px]">schedule</span> Listed ${listingAge(top3[0].created_at).date}
                      </span>
                      <span class="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider ${
                        listingAge(top3[0].created_at).days <= 7 
                          ? 'bg-emerald-50 text-emerald-700' 
                          : listingAge(top3[0].created_at).days <= 30 
                            ? 'bg-amber-50 text-amber-700' 
                            : 'bg-slate-50 text-slate-600'
                      }">${listingAge(top3[0].created_at).label}</span>
                    </div>
                  </div>
                </div>
                ${top3.slice(1).map(l => `
                <div onclick="window.location.href='property-details.html?id=${l.id}'"
                     class="bg-white border border-slate-200 flex flex-col shadow-sm cursor-pointer hover:shadow-lg transition-all">
                  <div class="h-48 relative overflow-hidden">
                    <img src="${l.img || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80'}" class="w-full h-full object-cover">
                    <div class="absolute top-4 left-4 bg-white/90 backdrop-blur px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest text-slate-900">${l.type}</div>
                  </div>
                  <div class="p-6 flex-1 flex flex-col">
                    <h3 class="text-lg font-black text-slate-900 mb-1">₹${l.price}${l.intent === 'Rent' ? '' : ' Cr'}</h3>
                    <p class="text-xs font-bold text-slate-500 mb-4 truncate">${escHtml(l.title)}</p>
                    <div class="flex items-center gap-4 mt-auto pt-4 border-t border-slate-50">
                      <div class="flex items-center gap-1.5 text-slate-400"><span class="material-symbols-outlined text-[14px]">bed</span><span class="text-[10px] font-black text-slate-900">${l.beds}</span></div>
                      <div class="flex items-center gap-1.5 text-slate-400"><span class="material-symbols-outlined text-[14px]">square_foot</span><span class="text-[10px] font-black text-slate-900">${(l.sqft || 0).toLocaleString()}</span></div>
                    </div>
                    <div class="mt-3 pt-2 border-t border-slate-50 flex items-center justify-between text-[10px]">
                      <span class="font-bold text-slate-400 uppercase tracking-widest">${listingAge(l.created_at).date}</span>
                      <span class="font-extrabold uppercase tracking-wider ${
                        listingAge(l.created_at).days <= 7 
                          ? 'text-emerald-600' 
                          : listingAge(l.created_at).days <= 30 
                            ? 'text-amber-600' 
                            : 'text-slate-500'
                      }">${listingAge(l.created_at).label}</span>
                    </div>
                  </div>
                </div>
                `).join('')}
                <!-- Dynamic Insight (keep as static design for aesthetics) -->
                <div class="md:col-span-2 bg-slate-900 text-white p-10 relative overflow-hidden group min-h-[240px] flex items-center">
                  <div class="relative z-10">
                    <h3 class="text-3xl font-black mb-4">Data-Driven <span class="text-cyan-400">Insights.</span></h3>
                    <p class="text-sm text-slate-400 mb-8 max-w-md">Our proprietary engine analyzes market trends across Mumbai & Delhi to identify high-yield opportunities.</p>
                    <button onclick="window.location.href='map.html'" class="bg-cyan-500 text-slate-900 px-6 py-3 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-cyan-400 transition-colors">Explore Heatmap</button>
                  </div>
                  <div class="absolute -right-20 -bottom-20 w-80 h-80 bg-cyan-500/10 rounded-full blur-[80px]"></div>
                </div>
            `;
        }
    }
}

async function initBuyerListingsPage() {
    const propertyGrid = document.getElementById('property-grid');
    if (!propertyGrid) return;

    // ── [Fetch & Render from Supabase] ──
    const urlParams = new URLSearchParams(window.location.search);
    const brokerId = urlParams.get('brokerId');
    const intent = urlParams.get('intent');

    let listings = (await getListings()).filter(l => l.status === 'Active');

    if (brokerId) {
        listings = listings.filter(l => l.broker_id === brokerId);
    }
    if (intent) {
        listings = listings.filter(l => l.intent.toLowerCase() === intent.toLowerCase());
    }
    
    propertyGrid.innerHTML = listings.map(l => `
        <div class="group cursor-pointer property-card bg-white rounded-3xl border border-slate-200 hover:shadow-xl overflow-hidden transition-all duration-300" 
             data-id="${l.id}" data-title="${escHtml(l.title)}" data-location="${escHtml(l.location)}" 
             data-type="${l.type}" data-beds="${l.beds}" data-baths="${l.baths}" data-price="${l.price}" data-date="${l.created_at}">
          <div class="aspect-[16/9] overflow-hidden relative bg-slate-100">
            <img loading="lazy" src="${l.img || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80'}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700">
            <div class="absolute top-4 left-4 bg-white/95 backdrop-blur px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest shadow-sm">${l.intent}</div>
            <button aria-label="Save Property" class="save-property-btn absolute top-4 right-4 w-9 h-9 flex items-center justify-center bg-white/90 backdrop-blur rounded-full shadow text-slate-400 hover:text-error transition-colors">
              <span class="material-symbols-outlined text-[20px]">favorite</span>
            </button>
            <button aria-label="Share Property" class="share-property-btn absolute top-4 right-[52px] w-9 h-9 flex items-center justify-center bg-white/90 backdrop-blur rounded-full shadow text-slate-400 hover:text-blue-500 transition-colors z-10" onclick="event.stopPropagation();">
              <span class="material-symbols-outlined text-[20px]">share</span>
            </button>
            <button aria-label="Report Property" class="report-property-btn absolute top-4 right-[100px] w-9 h-9 flex items-center justify-center bg-white/90 backdrop-blur rounded-full shadow text-slate-400 hover:text-red-500 transition-colors z-10" onclick="event.stopPropagation(); window.openReportModal('listing', '${l.id}', '${escHtml(l.title)}');">
              <span class="material-symbols-outlined text-[20px]">flag</span>
            </button>
          </div>
          <div class="p-5">
            <div class="flex justify-between items-start mb-1">
              <h3 class="text-xl font-black text-slate-900">₹${l.price}${l.intent === 'Rent' ? '' : ' Cr'}</h3>
            </div>
            <p class="text-slate-500 text-sm font-medium mb-4 truncate">${escHtml(l.title)}, ${escHtml(l.location)}</p>
            <div class="flex flex-wrap items-center gap-y-2 gap-x-4 text-slate-400">
              <div class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">bed</span><span class="text-xs font-black text-slate-900">${l.beds}</span></div>
              <div class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">bathtub</span><span class="text-xs font-black text-slate-900">${l.baths}</span></div>
              <div class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">square_foot</span><span class="text-xs font-black text-slate-900">${(l.sqft || 0).toLocaleString()} <span class="font-normal text-slate-400">sqft</span></span></div>
            </div>
            <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                <span class="material-symbols-outlined text-[14px]">schedule</span> Listed ${listingAge(l.created_at).date}
              </span>
              <span class="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider ${
                listingAge(l.created_at).days <= 7 
                  ? 'bg-emerald-50 text-emerald-700' 
                  : listingAge(l.created_at).days <= 30 
                    ? 'bg-amber-50 text-amber-700' 
                    : 'bg-slate-50 text-slate-600'
              }">${listingAge(l.created_at).label}</span>
            </div>
          </div>
        </div>
    `).join('');

    // ── [Data Initialization] ──
    let savedProperties = [];
    try {
        savedProperties = JSON.parse(localStorage.getItem('savedProperties') || '[]');
    } catch (e) { savedProperties = []; }

    const cards = Array.from(document.querySelectorAll('.property-card'));
    const countText = document.getElementById('listings-count-text');

    // ── [Helper: Update Visible Count] ──
    const updateCount = () => {
        const visibleCount = cards.filter(c => c.style.display !== 'none').length;
        if (countText) countText.textContent = `Showing ${visibleCount} exceptional listings in Mumbai & Delhi`;
    };

    // ── [Helper: Load Saved State] ──
    const syncSavedHearts = () => {
        cards.forEach(card => {
            const id = card.dataset.id;
            const btn = card.querySelector('.save-property-btn');
            const icon = btn?.querySelector('.material-symbols-outlined');
            if (savedProperties.includes(id)) {
                if (icon) icon.style.fontVariationSettings = "'FILL' 1";
                btn?.classList.add('text-error');
            } else {
                if (icon) icon.style.fontVariationSettings = "'FILL' 0";
                btn?.classList.remove('text-error');
            }
        });
    };
    syncSavedHearts();

    // ── [Search & Filter Logic] ──
    const applyFilters = () => {
        const query = document.getElementById('listing-search-input')?.value.toLowerCase() || '';
        const selectedTypes = Array.from(document.querySelectorAll('input[name="type"]:checked')).map(i => i.value);
        const minPrice = parseFloat(document.getElementById('price-min')?.value) || 0;
        const maxPrice = parseFloat(document.getElementById('price-max')?.value) || Infinity;
        
        const activeBeds = document.querySelector('button[data-filter="beds"].bg-primary')?.dataset.value || 0;
        const activeBaths = document.querySelector('button[data-filter="baths"].bg-primary')?.dataset.value || 0;

        cards.forEach(card => {
            const title = card.dataset.title.toLowerCase();
            const location = card.dataset.location.toLowerCase();
            const type = card.dataset.type;
            const beds = parseFloat(card.dataset.beds);
            const baths = parseFloat(card.dataset.baths);
            const price = parseFloat(card.dataset.price);

            const matchesSearch = !query || title.includes(query) || location.includes(query);
            const matchesType = selectedTypes.length === 0 || selectedTypes.includes(type);
            const matchesBeds = beds >= parseFloat(activeBeds);
            const matchesBaths = baths >= parseFloat(activeBaths);
            const matchesPrice = price >= minPrice && price <= maxPrice;

            if (matchesSearch && matchesType && matchesBeds && matchesBaths && matchesPrice) {
                card.style.display = 'block';
            } else {
                card.style.display = 'none';
            }
        });
        updateCount();
    };

    // ── [Sort Logic] ──
    const sortCards = () => {
        const sortVal = document.getElementById('sort-dropdown')?.value;
        const sortedCards = [...cards].sort((a, b) => {
            if (sortVal === 'price-low') return parseFloat(a.dataset.price) - parseFloat(b.dataset.price);
            if (sortVal === 'price-high') return parseFloat(b.dataset.price) - parseFloat(a.dataset.price);
            if (sortVal === 'newest') return new Date(b.dataset.date) - new Date(a.dataset.date);
            return 0; // recommended/default
        });
        
        if (propertyGrid) {
            propertyGrid.innerHTML = '';
            sortedCards.forEach(c => propertyGrid.appendChild(c));
        }
    };

    // ── [Event Listeners] ──
    document.getElementById('find-homes-btn')?.addEventListener('click', applyFilters);
    document.getElementById('listing-search-input')?.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') applyFilters();
    });

    document.querySelectorAll('input[name="type"], #price-min, #price-max').forEach(el => {
        el.addEventListener('change', applyFilters);
    });

    // Allow Enter key on price inputs to trigger filter
    ['price-min', 'price-max'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyFilters();
        });
    });

    document.querySelectorAll('button[data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            const filterType = btn.dataset.filter;
            document.querySelectorAll(`button[data-filter="${filterType}"]`).forEach(b => {
                b.classList.remove('bg-primary', 'text-on-primary');
            });
            btn.classList.add('bg-primary', 'text-on-primary');
            applyFilters();
        });
    });

    document.getElementById('clear-all-filters')?.addEventListener('click', () => {
        document.getElementById('listing-search-input').value = '';
        document.querySelectorAll('input[name="type"]').forEach(i => i.checked = false);
        document.getElementById('price-min').value = '';
        document.getElementById('price-max').value = '';
        document.querySelectorAll('button[data-filter]').forEach(b => b.classList.remove('bg-primary', 'text-on-primary'));
        applyFilters();
        showToast('All filters cleared.');
    });

    document.getElementById('sort-dropdown')?.addEventListener('change', sortCards);

    // ── [Grid/List Toggle] ──
    const gridBtn = document.getElementById('view-grid');
    const listBtn = document.getElementById('view-list');
    if (gridBtn && listBtn && propertyGrid) {
        gridBtn.onclick = () => {
            propertyGrid.className = 'grid grid-cols-1 md:grid-cols-2 gap-10';
            gridBtn.classList.add('bg-white', 'shadow-sm', 'text-primary');
            listBtn.classList.remove('bg-white', 'shadow-sm', 'text-primary');
            cards.forEach(c => c.classList.remove('flex', 'gap-6', 'items-center'));
            showToast('Switched to Grid View');
        };
        listBtn.onclick = () => {
            propertyGrid.className = 'grid grid-cols-1 gap-8';
            listBtn.classList.add('bg-white', 'shadow-sm', 'text-primary');
            gridBtn.classList.remove('bg-white', 'shadow-sm', 'text-primary');
            cards.forEach(c => c.classList.add('flex', 'gap-6', 'items-center'));
            showToast('Switched to List View');
        };
    }

    // ── [Card Interactions] ──
    cards.forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.save-property-btn')) return;
            if (e.target.closest('.report-property-btn')) return;
            if (e.target.closest('.share-property-btn')) {
                const url = window.location.origin + '/property-details.html?id=' + (card.dataset.id || '');
                navigator.clipboard.writeText(url).then(() => {
                    showToast('Link copied to clipboard!');
                }).catch(() => {
                    showToast('Failed to copy link.');
                });
                return;
            }
            navigateTo(`property-details.html?id=${card.dataset.id}`);
        });

        const saveBtn = card.querySelector('.save-property-btn');
        saveBtn?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = card.dataset.id;
            const index = savedProperties.indexOf(id);
            if (index > -1) {
                savedProperties.splice(index, 1);
                showToast('Removed from saved properties.');
            } else {
                savedProperties.push(id);
                showToast('Property saved to your favorites.');
            }
            localStorage.setItem('savedProperties', JSON.stringify(savedProperties));
            syncSavedHearts();

            // Sync to Supabase if logged in
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('preferences')
                    .eq('id', session.user.id)
                    .single();
                const merged = {
                    ...(profile?.preferences || {}),
                    saved_listings: savedProperties
                };
                await supabase
                    .from('profiles')
                    .update({ preferences: merged })
                    .eq('id', session.user.id);
            }
        });
    });

    // ── [Pagination] ──
    document.querySelectorAll('.pagination-btn').forEach(btn => {
        btn.onclick = () => showToast('Pagination is demo-only in this build.');
    });

    // Handle initial search & filters from URL
    const q = urlParams.get('q');
    const minPrice = urlParams.get('minPrice');
    const maxPrice = urlParams.get('maxPrice');
    const typeParam = urlParams.get('type');
    const beds = urlParams.get('beds');
    const baths = urlParams.get('baths');

    let shouldApply = false;

    if (q) {
        const input = document.getElementById('listing-search-input');
        if (input) {
            input.value = q;
            shouldApply = true;
        }
    }
    if (minPrice) {
        const input = document.getElementById('price-min');
        if (input) {
            input.value = minPrice;
            shouldApply = true;
        }
    }
    if (maxPrice) {
        const input = document.getElementById('price-max');
        if (input) {
            input.value = maxPrice;
            shouldApply = true;
        }
    }
    if (typeParam) {
        const types = typeParam.split(',');
        document.querySelectorAll('input[name="type"]').forEach(checkbox => {
            if (types.includes(checkbox.value)) {
                checkbox.checked = true;
                shouldApply = true;
            }
        });
    }
    if (beds) {
        const btn = document.querySelector(`button[data-filter="beds"][data-value="${beds}"]`);
        if (btn) {
            document.querySelectorAll('button[data-filter="beds"]').forEach(b => {
                b.classList.remove('bg-primary', 'text-on-primary');
            });
            btn.classList.add('bg-primary', 'text-on-primary');
            shouldApply = true;
        }
    }
    if (baths) {
        const btn = document.querySelector(`button[data-filter="baths"][data-value="${baths}"]`);
        if (btn) {
            document.querySelectorAll('button[data-filter="baths"]').forEach(b => {
                b.classList.remove('bg-primary', 'text-on-primary');
            });
            btn.classList.add('bg-primary', 'text-on-primary');
            shouldApply = true;
        }
    }

    if (shouldApply || brokerId || intent) {
        applyFilters();
    }
}

async function initBuyerMapPage() {
  function formatMapPrice(price, intent) {
    const p = parseFloat(price);
    if (isNaN(p)) return '—';
    if (intent === 'Rent') {
      const lac = p * 100;
      if (lac >= 1) return `₹${lac % 1 === 0 ? lac : lac.toFixed(1)}L/mo`;
      return `₹${(lac * 100000).toLocaleString('en-IN')}`;
    }
    if (p >= 1) return `₹${p % 1 === 0 ? p : p.toFixed(1)} Cr`;
    return `₹${(p * 100).toFixed(0)} L`;
  }

    console.log('Initializing Map with Supabase data...');
    if (typeof L === 'undefined') {
        console.error('Leaflet is not loaded!');
        return;
    }

    const indiaBounds = L.latLngBounds(
        L.latLng(6.5, 68.1), // Southwest
        L.latLng(35.6, 97.4)  // Northeast
    );

    const urlParams = new URLSearchParams(window.location.search);
    const latParam = urlParams.get('lat');
    const lngParam = urlParams.get('lng');
    const qParam = urlParams.get('q');
    
    let initialCenter = [19.0760, 72.8777]; // Mumbai Center
    let initialZoom = 13;

    if (latParam && lngParam) {
        initialCenter = [parseFloat(latParam), parseFloat(lngParam)];
        initialZoom = 15;
    }

    const map = L.map('map', {
        center: initialCenter,
        zoom: initialZoom,
        maxBounds: indiaBounds,
        maxBoundsViscosity: 1.0, 
        zoomControl: false
    });
    
    if (qParam) {
        setTimeout(() => {
            if (typeof showToast === 'function') showToast(`Showing results near ${escHtml(qParam.split(',')[0])}`);
        }, 800);
    }
    
    map.setMinZoom(map.getBoundsZoom(indiaBounds));
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; ProjectX India',
        subdomains: 'abcd',
        maxZoom: 18,
        bounds: indiaBounds
    }).addTo(map);

    document.getElementById('map').style.background = '#ebebeb';

    // Load Listings from Supabase
    const listings = (await getListings()).filter(l => l.status === 'Active');
    
    // Filter to those with coordinates
    const markersData = listings.filter(l => l.lat !== null && l.lng !== null).map(l => {
        return { ...l, lat: parseFloat(l.lat), lng: parseFloat(l.lng) };
    });

    const withoutCoords = listings.filter(l => l.lat === null || l.lng === null);

    const markers = [];
    let activeListingId = null;
    let isProgrammaticMove = false;
    let lastValidBounds = null;

    function selectListing(id, fromMap = false) {
        activeListingId = id;
        const markerObj = markers.find(m => m.data.id == id);
        
        if (!fromMap && markerObj) {
            isProgrammaticMove = true;
            map.flyTo([markerObj.data.lat, markerObj.data.lng], 15, { animate: true, duration: 0.5 });
            markerObj.marker.openPopup();
            setTimeout(() => { isProgrammaticMove = false; }, 600);
        }

        updateSidebar();
        
        // Reset all pins to default state
        document.querySelectorAll('.map-pin-wrapper').forEach(wrapper => {
            wrapper.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';
            wrapper.style.transform = 'translate(-50%, -50%) scale(1)';
            wrapper.style.zIndex = '';
        });

        // Activate selected pin
        const pinEl = document.getElementById(`pin-${id}`);
        if (pinEl) {
            pinEl.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
            pinEl.style.transform = 'translate(-50%, -50%) scale(1.12)';
            pinEl.style.zIndex = '1000';
        }

        if (fromMap) {
            setTimeout(() => {
                const cardEl = document.getElementById(`card-${id}`);
                if (cardEl) {
                    cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
        }
    }

    markersData.forEach(p => {
        const intentColor = p.intent === 'Rent' 
            ? { dot: '#059669', ring: '#d1fae5', text: '#065f46' }   // emerald for Rent
            : { dot: '#0f172a', ring: '#e2e8f0', text: '#0f172a' };  // slate for Buy

        const icon = L.divIcon({
            className: 'bg-transparent border-none',
            html: `
              <div id="pin-${p.id}" class="map-pin-wrapper" style="
                position: relative;
                transform: translate(-50%, -50%);
                display: inline-flex;
                align-items: center;
                gap: 5px;
                background: white;
                border: 2px solid ${p.intent === 'Rent' ? '#059669' : '#0f172a'};
                border-radius: 999px;
                padding: 4px 10px 4px 6px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.12);
                cursor: pointer;
                transition: all 0.2s ease;
                white-space: nowrap;
              ">
                <div class="pin-dot" style="
                  width: 8px;
                  height: 8px;
                  background: ${p.intent === 'Rent' ? '#059669' : '#0f172a'};
                  border-radius: 50%;
                  flex-shrink: 0;
                  transition: all 0.2s ease;
                "></div>
                <span class="pin-label" style="
                  font-family: Outfit, sans-serif;
                  font-size: 12px;
                  font-weight: 800;
                  color: ${p.intent === 'Rent' ? '#059669' : '#0f172a'};
                  letter-spacing: 0.01em;
                ">${formatMapPrice(p.price, p.intent)}</span>
              </div>
            `,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
        });

        const marker = L.marker([p.lat, p.lng], { icon }).addTo(map);
        
        marker.bindPopup(`
            <div class="p-2 min-w-[150px]">
                <h4 class="font-bold text-sm text-slate-900">₹${p.price}${p.intent === 'Rent' ? '' : ' Cr'}</h4>
                <p class="text-xs font-medium text-slate-500 mt-0.5">${escHtml(p.title)}</p>
                <div class="flex items-center gap-2 mt-2 text-slate-600 text-[10px] font-bold">
                    <span>${p.beds} BEDS</span> &bull; <span>${p.baths} BATHS</span>
                </div>
                <button onclick="window.location.href='property-details.html?id=${p.id}'" class="mt-3 w-full bg-slate-900 text-white px-3 py-1.5 rounded text-[10px] uppercase font-bold hover:bg-slate-800 transition-colors">View Details</button>
            </div>
        `, { closeButton: false, offset: [0, -35] });

        marker.on('click', () => selectListing(p.id, true));
        marker.on('mouseover', () => {
            const wrapper = document.getElementById(`pin-${p.id}`);
            if (wrapper) {
                const tooltip = wrapper.querySelector('.pin-tooltip');
                if (tooltip) {
                    tooltip.style.opacity = '1';
                    tooltip.style.transform = 'translateX(-50%) translateY(0)';
                }
            }
        });
        marker.on('mouseout', () => {
            if (activeListingId == p.id) return;
            const wrapper = document.getElementById(`pin-${p.id}`);
            if (wrapper) {
                const tooltip = wrapper.querySelector('.pin-tooltip');
                if (tooltip) {
                    tooltip.style.opacity = '0';
                    tooltip.style.transform = 'translateX(-50%) translateY(4px)';
                }
            }
        });
        markers.push({ marker, data: p });
    });

    const sidebarContainer = document.querySelector('.overflow-y-auto.p-6');
    const matchesCountEl = document.querySelector('#map-listings-count');

    window.toggleMapFavorite = async function(e, id) {
        e.stopPropagation();
        let saved = JSON.parse(localStorage.getItem('savedProperties') || '[]');
        if (saved.includes(id)) {
            saved = saved.filter(savedId => savedId != id);
            showToast('Removed from favorites');
        } else {
            saved.push(id);
            showToast('Added to favorites');
        }
        localStorage.setItem('savedProperties', JSON.stringify(saved));
        updateSidebar();

        // Sync to Supabase if logged in
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            const { data: profile } = await supabase
                .from('profiles')
                .select('preferences')
                .eq('id', session.user.id)
                .single();
            const merged = {
                ...(profile?.preferences || {}),
                saved_listings: saved
            };
            await supabase
                .from('profiles')
                .update({ preferences: merged })
                .eq('id', session.user.id);
        }
    };

    window.clickSidebarCard = function(id) {
        selectListing(id, false);
    };

    function updateSidebar() {
        if (isProgrammaticMove) return;

        let bounds = map.getBounds();
        const mapPane = document.getElementById('map-pane');
        const mapHeight = mapPane ? mapPane.offsetHeight : 0;
        if (window.innerWidth < 768) {
            if (mapHeight > 150) {
                lastValidBounds = bounds;
            } else if (lastValidBounds) {
                bounds = lastValidBounds;
            }
        }

        const visibleListings = markersData.filter(p => bounds.contains([p.lat, p.lng]));
        
        if (matchesCountEl) {
            matchesCountEl.textContent = `${visibleListings.length} MATCHES FOUND`;
        }

        if (!sidebarContainer) return;

        if (visibleListings.length === 0) {
            sidebarContainer.innerHTML = '<p class="text-slate-500 text-center mt-10">No properties found in this area.</p>';
            return;
        }

        let saved = JSON.parse(localStorage.getItem('savedProperties') || '[]');

        sidebarContainer.innerHTML = visibleListings.map(l => {
            const isSaved = saved.includes(l.id);
            const isActive = activeListingId == l.id;
            const activeClasses = isActive ? 'ring-4 ring-slate-900 shadow-2xl scale-[1.02]' : 'border-slate-100 hover:shadow-xl';
            
            return `
            <div id="card-${l.id}" class="listing-card cursor-pointer bg-white rounded-3xl border ${activeClasses} overflow-hidden transition-all duration-300" onclick="clickSidebarCard(${l.id})">
              <div class="aspect-[16/9] overflow-hidden relative bg-slate-100">
                <img loading="lazy" src="${l.img || 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80'}" class="w-full h-full object-cover transition-transform duration-700 ${isActive ? '' : 'group-hover:scale-105'}">
                <div class="absolute top-4 left-4 bg-white/95 backdrop-blur px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest shadow-sm">${escHtml(l.intent)}</div>
              </div>
              <div class="p-5">
                <div class="flex justify-between items-start mb-1">
                  <h3 class="text-xl font-black text-slate-900">₹${l.price}${l.intent === 'Rent' ? '' : ' Cr'}</h3>
                  <div class="flex items-center gap-2">
                    <button class="transition-colors text-slate-200 hover:text-red-500 flex items-center justify-center" onclick="event.stopPropagation(); window.openReportModal('listing', ${l.id}, '${escHtml(l.title)}');" title="Report Listing">
                      <span class="material-symbols-outlined text-[20px]">flag</span>
                    </button>
                    <button class="transition-colors ${isSaved ? 'text-red-500' : 'text-slate-200 hover:text-red-500'}" onclick="toggleMapFavorite(event, ${l.id})">
                      <span class="material-symbols-outlined text-[24px]" style="font-variation-settings: 'FILL' ${isSaved ? '1' : '0'};">favorite</span>
                    </button>
                  </div>
                </div>
                <p class="text-slate-500 text-sm font-medium mb-4 truncate">${escHtml(l.title)}, ${escHtml(l.location)}</p>
                <div class="flex flex-wrap items-center gap-y-2 gap-x-4 text-slate-400">
                  <div class="flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-[18px]">bed</span>
                    <span class="text-xs font-black text-slate-900">${l.beds}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-[18px]">bathtub</span>
                    <span class="text-xs font-black text-slate-900">${l.baths}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-[18px]">square_foot</span>
                    <span class="text-xs font-black text-slate-900">${(l.sqft || 0).toLocaleString()} <span class="font-normal text-slate-400">sqft</span></span>
                  </div>
                </div>
                <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <span class="material-symbols-outlined text-[14px]">schedule</span> Listed ${listingAge(l.created_at).date}
                  </span>
                  <span class="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider ${
                    listingAge(l.created_at).days <= 7 
                      ? 'bg-emerald-50 text-emerald-700' 
                      : listingAge(l.created_at).days <= 30 
                        ? 'bg-amber-50 text-amber-700' 
                        : 'bg-slate-50 text-slate-600'
                  }">${listingAge(l.created_at).label}</span>
                </div>
              </div>
            </div>
            `;
        }).join('');

        document.querySelectorAll('.map-pin-wrapper').forEach(wrapper => {
            wrapper.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';
            wrapper.style.transform = 'translate(-50%, -50%) scale(1)';
            wrapper.style.zIndex = '';
        });
        if (activeListingId) {
            const pinEl = document.getElementById(`pin-${activeListingId}`);
            if (pinEl) {
                pinEl.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
                pinEl.style.transform = 'translate(-50%, -50%) scale(1.12)';
                pinEl.style.zIndex = '1000';
            }
        }
    }

    map.on('moveend', updateSidebar);
    setTimeout(updateSidebar, 100);

    // Geocode missing coordinates on the fly to support legacy listings
    withoutCoords.forEach((l, index) => {
        setTimeout(() => {
            fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(l.location)}&countrycodes=IN&limit=1`)
                .then(res => res.json())
                .then(data => {
                    if (data && data.length > 0) {
                        const item = data[0];
                        const lat = parseFloat(item.lat);
                        const lng = parseFloat(item.lon);
                        
                        const updatedListing = { ...l, lat, lng };
                        markersData.push(updatedListing);
                        
                        const icon = L.divIcon({
                            className: 'bg-transparent border-none',
                            html: `
                              <div id="pin-${l.id}" class="map-pin-wrapper" style="
                                position: relative;
                                transform: translate(-50%, -50%);
                                display: inline-flex;
                                align-items: center;
                                gap: 5px;
                                background: white;
                                border: 2px solid ${l.intent === 'Rent' ? '#059669' : '#0f172a'};
                                border-radius: 999px;
                                padding: 4px 10px 4px 6px;
                                box-shadow: 0 2px 8px rgba(0,0,0,0.12);
                                cursor: pointer;
                                transition: all 0.2s ease;
                                white-space: nowrap;
                              ">
                                <div class="pin-dot" style="
                                  width: 8px;
                                  height: 8px;
                                  background: ${l.intent === 'Rent' ? '#059669' : '#0f172a'};
                                  border-radius: 50%;
                                  flex-shrink: 0;
                                  transition: all 0.2s ease;
                                "></div>
                                <span class="pin-label" style="
                                  font-family: Outfit, sans-serif;
                                  font-size: 12px;
                                  font-weight: 800;
                                  color: ${l.intent === 'Rent' ? '#059669' : '#0f172a'};
                                  letter-spacing: 0.01em;
                                ">${formatMapPrice(l.price, l.intent)}</span>
                              </div>
                            `,
                            iconSize: [0, 0],
                            iconAnchor: [0, 0]
                        });
                        
                        const marker = L.marker([lat, lng], { icon }).addTo(map);
                        marker.bindPopup(`
                            <div class="p-2 min-w-[150px]">
                                <h4 class="font-bold text-sm text-slate-900">₹${l.price}${l.intent === 'Rent' ? '' : ' Cr'}</h4>
                                <p class="text-xs font-medium text-slate-500 mt-0.5">${escHtml(l.title)}</p>
                                <div class="flex items-center gap-2 mt-2 text-slate-600 text-[10px] font-bold">
                                    <span>${l.beds} BEDS</span> &bull; <span>${l.baths} BATHS</span>
                                </div>
                                <button onclick="window.location.href='property-details.html?id=${l.id}'" class="mt-3 w-full bg-slate-900 text-white px-3 py-1.5 rounded text-[10px] uppercase font-bold hover:bg-slate-800 transition-colors">View Details</button>
                            </div>
                        `, { closeButton: false, offset: [0, -35] });
                        
                        marker.on('click', () => selectListing(l.id, true));
                        marker.on('mouseover', () => {
                            const wrapper = document.getElementById(`pin-${l.id}`);
                            if (wrapper) {
                                const tooltip = wrapper.querySelector('.pin-tooltip');
                                if (tooltip) {
                                    tooltip.style.opacity = '1';
                                    tooltip.style.transform = 'translateX(-50%) translateY(0)';
                                }
                            }
                        });
                        marker.on('mouseout', () => {
                            if (activeListingId == l.id) return;
                            const wrapper = document.getElementById(`pin-${l.id}`);
                            if (wrapper) {
                                const tooltip = wrapper.querySelector('.pin-tooltip');
                                if (tooltip) {
                                    tooltip.style.opacity = '0';
                                    tooltip.style.transform = 'translateX(-50%) translateY(4px)';
                                }
                            }
                        });
                        markers.push({ marker, data: updatedListing });
                        
                        updateSidebar();
                    }
                })
                .catch(err => console.error('On-the-fly geocoding failed:', err));
        }, index * 1000); // 1-second delay between requests to comply with Nominatim's strict rate limits
    });

    // Map Search
    const searchInput = document.getElementById('map-location-search');
    const searchBtn = document.getElementById('map-search-btn');
    const resultsContainer = document.getElementById('map-search-results');
    let debounceTimer;

    if (searchBtn && searchInput) {
        searchBtn.onclick = () => {
            const val = searchInput.value.trim();
            if (val) {
                 fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(val)}&countrycodes=IN&limit=1`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.length > 0) {
                            const item = data[0];
                            map.flyTo([item.lat, item.lon], 15, { animate: true, duration: 1 });
                            showToast(`Showing results near ${item.display_name.split(',')[0]}`);
                        }
                    });
            }
        };
        searchInput.onkeypress = (e) => { if (e.key === 'Enter') searchBtn.click(); };

        if (resultsContainer) {
            searchInput.addEventListener('input', (e) => {
                clearTimeout(debounceTimer);
                const query = e.target.value.trim();
                if (query.length < 3) { resultsContainer.classList.add('hidden'); return; }
                
                debounceTimer = setTimeout(() => {
                    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=IN&limit=5`)
                        .then(res => res.json())
                        .then(data => {
                            resultsContainer.innerHTML = '';
                            if (data.length === 0) {
                                resultsContainer.innerHTML = '<div class="p-4 text-sm text-slate-500 font-medium">No locations found.</div>';
                            } else {
                                data.forEach(item => {
                                    const div = document.createElement('div');
                                    div.className = 'px-4 py-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0 transition-colors flex items-center gap-3';
                                    div.innerHTML = `<span class="material-symbols-outlined text-slate-400 text-[18px]">location_on</span><span class="text-xs font-medium text-slate-700 truncate" title="${item.display_name}">${item.display_name}</span>`;
                                    div.onclick = () => {
                                        searchInput.value = item.display_name.split(',')[0];
                                        resultsContainer.classList.add('hidden');
                                        map.flyTo([item.lat, item.lon], 15, { animate: true, duration: 1 });
                                        showToast(`Showing results near ${item.display_name.split(',')[0]}`);
                                    };
                                    resultsContainer.appendChild(div);
                                });
                            }
                            resultsContainer.classList.remove('hidden');
                            resultsContainer.classList.add('flex');
                        });
                }, 300);
            });
            document.addEventListener('click', (e) => {
                if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
                    resultsContainer.classList.add('hidden');
                }
            });
        }
    }
}

async function initBuyerDetailsPage() {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) return;

    // Fetch from Supabase
    const { data: l, error } = await supabase.from('listings').select('*').eq('id', id).single();
    if (error || !l) {
        showToast('Property not found.');
        return;
    }

    // Check if the user is authorized to view non-Active properties
    const { data: { session } } = await supabase.auth.getSession();
    const isOwner = session && session.user && session.user.id === l.broker_id;
    const isStaff = userRole === 'Admin' || userRole === 'Employee';
    const isAdminPreview = new URLSearchParams(window.location.search).get('adminPreview') === '1';
    if (l.status !== 'Active' && !isOwner && !isStaff && !isAdminPreview) {
        showToast('Property details are pending review or unavailable.', true);
        setTimeout(() => { window.location.href = 'properties.html'; }, 2000);
        return;
    }

    // Render Moderation History timeline for owner or staff
    if (isOwner || isStaff) {
        const modHistorySec = document.getElementById('moderation-history-section');
        const modHistoryTimeline = document.getElementById('moderation-history-timeline');
        if (modHistorySec && modHistoryTimeline) {
            try {
                const { data: logs, error: logsError } = await supabase
                    .from('listing_status_history')
                    .select('*, profiles(full_name, role)')
                    .eq('listing_id', id)
                    .order('created_at', { ascending: false });

                if (logsError) throw logsError;

                modHistorySec.classList.remove('hidden');

                if (!logs || logs.length === 0) {
                    modHistoryTimeline.innerHTML = `<div class="text-xs text-slate-400 italic">No moderation history logged yet.</div>`;
                } else {
                    modHistoryTimeline.innerHTML = logs.map(log => {
                        const dateStr = log.created_at ? new Date(log.created_at).toLocaleString('en-IN') : '—';
                        const newStatusVal = log.new_status === 'Active' ? 'Approved' : log.new_status;
                        const oldStatusVal = log.old_status ? (log.old_status === 'Active' ? 'Approved' : log.old_status) : 'None';
                        
                        let dotColor = 'bg-slate-400';
                        if (log.new_status === 'Active') dotColor = 'bg-emerald-500 ring-4 ring-emerald-100';
                        else if (log.new_status === 'Rejected') dotColor = 'bg-rose-500 ring-4 ring-rose-100';
                        else if (log.new_status === 'Suspended') dotColor = 'bg-slate-700 ring-4 ring-slate-200';
                        else if (log.new_status === 'Under Review') dotColor = 'bg-blue-500 ring-4 ring-blue-100';
                        else if (log.new_status === 'Pending') dotColor = 'bg-amber-500 ring-4 ring-amber-100';

                        return `
                            <div class="relative">
                                <!-- Timeline Dot -->
                                <div class="absolute left-0 top-1.5 w-3 h-3 rounded-full -translate-x-[30.5px] ${dotColor}"></div>
                                <div class="flex flex-col gap-1 font-sans">
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs font-bold text-slate-800">
                                            ${oldStatusVal} ➔ ${newStatusVal}
                                        </span>
                                        <span class="text-[10px] text-slate-400 font-semibold">• ${dateStr}</span>
                                    </div>
                                    <p class="text-xs text-slate-600 font-medium">
                                        Changed by: <span class="font-bold text-slate-700">${log.profiles?.full_name || 'System'}</span> 
                                        (${log.profiles?.role || 'System'})
                                    </p>
                                    <div class="text-xs bg-slate-50 border border-slate-100 rounded-lg p-2.5 mt-1 text-slate-500 italic font-medium">
                                        "${log.reason}"
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            } catch (err) {
                console.error("Failed to load moderation history:", err);
            }
        }
    }

    // Update top status badge dynamically
    const statusBadge = document.getElementById('detail-status-badge');
    if (statusBadge) {
        statusBadge.textContent = l.status;
        if (l.status === 'Active') {
            statusBadge.className = 'bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest';
        } else if (l.status === 'Pending') {
            statusBadge.className = 'bg-amber-100 text-amber-800 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest';
        } else if (l.status === 'Flagged') {
            statusBadge.className = 'bg-rose-100 text-rose-800 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest';
        } else if (l.status === 'Sold') {
            statusBadge.className = 'bg-slate-100 text-slate-800 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest';
        }
    }

    if (isAdminPreview) {
        const banner = document.createElement('div');
        banner.id = 'admin-preview-banner';
        banner.className = 'fixed top-0 left-0 right-0 z-[999] bg-amber-500 text-amber-950 text-center text-xs font-black uppercase tracking-widest py-2 flex items-center justify-center gap-2';
        banner.innerHTML = `<span class="material-symbols-outlined text-[16px]">admin_panel_settings</span> Admin Preview Mode — Status: ${l.status} — Changes made here are live`;
        document.body.prepend(banner);
        document.body.style.paddingTop = '96px';

        // Push down the fixed navigation bar
        const navBar = document.querySelector('nav');
        if (navBar) {
            navBar.style.top = '32px';
        }

        // Hide buyer navigation links (Search your home, Services)
        const navContainer = document.querySelector('nav .hidden.md\\:flex');
        if (navContainer) {
            navContainer.style.setProperty('display', 'none', 'important');
        }

        // Append "Admin Preview" tag next to logo
        const logoContainer = Array.from(document.querySelectorAll('a')).find(a => a.textContent === 'ProjectX')?.parentElement;
        if (logoContainer && !document.getElementById('admin-preview-tag')) {
            const adminTag = document.createElement('span');
            adminTag.id = 'admin-preview-tag';
            adminTag.className = 'bg-slate-900 text-white px-2.5 py-1 rounded-md text-[10px] font-black tracking-widest uppercase ml-2';
            adminTag.textContent = 'Admin Preview';
            logoContainer.appendChild(adminTag);
        }

        // Hide profile button in nav
        const rightContainer = document.querySelector('nav .flex.items-center.gap-4');
        if (rightContainer) {
            const profileBtn = Array.from(rightContainer.querySelectorAll('button')).find(btn => btn.querySelector('span')?.textContent === 'account_circle');
            if (profileBtn) {
                profileBtn.style.setProperty('display', 'none', 'important');
            }
        }

        // Hide buyer actions
        const inquiryForm = document.getElementById('buyer-inquiry-form');
        const chatSection = document.getElementById('buyer-chat-section');
        const reportBtn = document.getElementById('report-listing-btn');
        if (inquiryForm) inquiryForm.classList.add('hidden');
        if (chatSection) chatSection.classList.add('hidden');
        if (reportBtn) reportBtn.classList.add('hidden');

        // Create Moderation Panel
        const modPanel = document.createElement('div');
        modPanel.id = 'admin-moderation-panel';
        modPanel.className = 'space-y-6 mt-6 pt-6 border-t border-slate-100';
        
        let statusBadgeClass = 'bg-slate-100 text-slate-800';
        if (l.status === 'Active') statusBadgeClass = 'bg-emerald-100 text-emerald-800';
        else if (l.status === 'Pending') statusBadgeClass = 'bg-amber-100 text-amber-800';
        else if (l.status === 'Flagged') statusBadgeClass = 'bg-rose-100 text-rose-800';
        else if (l.status === 'Sold') statusBadgeClass = 'bg-slate-100 text-slate-800';

        const updateButtonsVisibility = (status) => {
            const showApprove = status !== 'Active';
            const showFlag = status !== 'Flagged' && status !== 'Sold';
            
            const approveBtn = modPanel.querySelector('#mod-approve-btn');
            const flagBtn = modPanel.querySelector('#mod-flag-btn');
            
            if (approveBtn) {
                if (showApprove) approveBtn.classList.remove('hidden');
                else approveBtn.classList.add('hidden');
            }
            if (flagBtn) {
                if (showFlag) flagBtn.classList.remove('hidden');
                else flagBtn.classList.add('hidden');
            }
        };

        modPanel.innerHTML = `
            <div>
                <h4 class="text-sm font-bold uppercase tracking-widest text-slate-400 mb-2">Moderation Console</h4>
                <div class="flex items-center gap-2 mb-4 bg-slate-50 p-3 rounded-2xl border border-slate-100">
                    <span class="text-xs font-bold text-slate-500">Current Status:</span>
                    <span class="px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider ${statusBadgeClass}" id="mod-status-badge">
                        ${l.status}
                    </span>
                </div>
            </div>
            <div class="flex flex-col gap-3">
                <button id="mod-approve-btn" class="w-full flex items-center justify-center gap-2 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold text-sm transition-colors shadow-sm ${l.status === 'Active' ? 'hidden' : ''}">
                    <span class="material-symbols-outlined text-[20px]">check_circle</span>
                    Approve Listing
                </button>
                <button id="mod-flag-btn" class="w-full flex items-center justify-center gap-2 py-3.5 bg-amber-500 hover:bg-amber-600 text-white rounded-2xl font-bold text-sm transition-colors shadow-sm ${(l.status === 'Flagged' || l.status === 'Sold') ? 'hidden' : ''}">
                    <span class="material-symbols-outlined text-[20px]">flag</span>
                    Flag Listing
                </button>
                <button id="mod-delete-btn" class="w-full flex items-center justify-center gap-2 py-3.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-100 rounded-2xl font-bold text-sm transition-colors">
                    <span class="material-symbols-outlined text-[20px]">delete</span>
                    Delete Listing
                </button>
            </div>
        `;

        if (inquiryForm && inquiryForm.parentElement) {
            inquiryForm.parentElement.appendChild(modPanel);
        }

        // Bind handler functions
        const approveBtn = modPanel.querySelector('#mod-approve-btn');
        if (approveBtn) {
            approveBtn.onclick = async () => {
                if (confirm(`Are you sure you want to approve "${l.title}"?`)) {
                    const { error } = await supabase.from('listings').update({ status: 'Active' }).eq('id', l.id);
                    if (error) {
                        showToast(error.message, true);
                    } else {
                        showToast('✓ Listing approved successfully');
                        l.status = 'Active';
                        const badge = document.getElementById('mod-status-badge');
                        if (badge) {
                            badge.textContent = 'Active';
                            badge.className = 'px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800';
                        }
                        if (statusBadge) {
                            statusBadge.textContent = 'Active';
                            statusBadge.className = 'bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest';
                        }
                        const topBanner = document.getElementById('admin-preview-banner');
                        if (topBanner) {
                            topBanner.innerHTML = `<span class="material-symbols-outlined text-[16px]">admin_panel_settings</span> Admin Preview Mode — Status: Active — Changes made here are live`;
                        }
                        updateButtonsVisibility('Active');
                    }
                }
            };
        }

        const flagBtn = modPanel.querySelector('#mod-flag-btn');
        if (flagBtn) {
            flagBtn.onclick = async () => {
                if (confirm(`Are you sure you want to flag "${l.title}"?`)) {
                    const { error } = await supabase.from('listings').update({ status: 'Flagged' }).eq('id', l.id);
                    if (error) {
                        showToast(error.message, true);
                    } else {
                        showToast('✓ Listing flagged successfully');
                        l.status = 'Flagged';
                        const badge = document.getElementById('mod-status-badge');
                        if (badge) {
                            badge.textContent = 'Flagged';
                            badge.className = 'px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider bg-rose-100 text-rose-800';
                        }
                        if (statusBadge) {
                            statusBadge.textContent = 'Flagged';
                            statusBadge.className = 'bg-rose-100 text-rose-800 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest';
                        }
                        const topBanner = document.getElementById('admin-preview-banner');
                        if (topBanner) {
                            topBanner.innerHTML = `<span class="material-symbols-outlined text-[16px]">admin_panel_settings</span> Admin Preview Mode — Status: Flagged — Changes made here are live`;
                        }
                        updateButtonsVisibility('Flagged');
                    }
                }
            };
        }

        const deleteBtn = modPanel.querySelector('#mod-delete-btn');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                if (confirm(`Are you sure you want to permanently delete "${l.title}"? This cannot be undone.`)) {
                    const { error } = await supabase.from('listings').delete().eq('id', l.id);
                    if (error) {
                        showToast(error.message, true);
                    } else {
                        showToast('✓ Listing deleted successfully');
                        setTimeout(() => {
                            window.close();
                        }, 1000);
                    }
                }
            };
        }
    }

    // Increment view count — but only if the viewer is NOT the listing owner
    if (!isOwner) {
        await supabase.rpc('increment_listing_views', { listing_id: id });
        l.views = (l.views || 0) + 1;
    }

    // Fetch and populate actual broker profile from Supabase
    let brokerName = 'Mehdi Ali'; // Default fallback
    let brokerRole = 'ProjectX Executive Partner';
    let brokerImg = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'; // professional default image
    
    if (l.broker_id) {
        const { data: brokerProfile } = await supabase.from('profiles').select('*').eq('id', l.broker_id).single();
        if (brokerProfile) {
            if (brokerProfile.full_name) {
                brokerName = brokerProfile.full_name;
            }
            if (brokerProfile.role) {
                brokerRole = `${brokerProfile.role}, ProjectX`;
            }
        }
    }
    
    const brokerNameEl = document.getElementById('detail-broker-name');
    if (brokerNameEl) {
        if (l.broker_id) {
            brokerNameEl.innerHTML = `<a href="/profile.html?id=${l.broker_id}" target="_blank" class="hover:text-slate-600 hover:underline flex items-center gap-1 transition-colors">
                ${escHtml(brokerName)}
                <span class="material-symbols-outlined text-[16px] inline-block font-normal">open_in_new</span>
            </a>`;
        } else {
            brokerNameEl.textContent = brokerName;
        }
    }
    
    const brokerRoleEl = document.getElementById('detail-broker-role');
    if (brokerRoleEl) brokerRoleEl.textContent = brokerRole;

    const brokerImgEl = document.getElementById('detail-broker-img');
    if (brokerImgEl) {
        if (brokerName.toLowerCase().includes('mehdi')) {
            brokerImgEl.src = 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=200&q=80'; // handsome male avatar for Mehdi
        } else {
            brokerImgEl.src = brokerImg;
        }
        if (l.broker_id) {
            brokerImgEl.classList.add('cursor-pointer', 'hover:opacity-95', 'transition-opacity');
            brokerImgEl.onclick = () => {
                window.open(`/profile.html?id=${l.broker_id}`, '_blank');
            };
        }
    }

    // Update page title
    document.title = `${l.title} — EstatePro`;

    // Property gallery from listing_media
    const galleryContainer = document.getElementById('property-gallery-container');
    if (galleryContainer) {
        const { data: mediaRows } = await supabase
            .from('listing_media')
            .select('url, media_type, sort_order, is_cover')
            .eq('listing_id', id)
            .order('sort_order', { ascending: true });
        const mediaItems = (mediaRows || []).map(row => ({
            url: row.url,
            media_type: row.media_type,
            is_cover: row.is_cover
        }));
        renderInteractiveGallery(galleryContainer, mediaItems, l.img);
    } else {
        const heroImg = document.querySelector('.hero-img');
        if (heroImg) heroImg.src = l.img || MEDIA_PLACEHOLDER;
    }

    // Price
    const priceEl = document.getElementById('detail-price');
    if (priceEl) priceEl.innerHTML = `₹${l.price}${l.intent === 'Rent' ? '' : ' Cr'}`;

    // Title & address
    const titleEl = document.getElementById('detail-title');
    if (titleEl) titleEl.textContent = l.title;
    const addrEl = document.getElementById('detail-address');
    if (addrEl) addrEl.innerHTML = `<span class="material-symbols-outlined text-[20px]">location_on</span> ${l.location}`;

    // Stats
    const bedsEl = document.getElementById('detail-beds');
    if (bedsEl) bedsEl.textContent = l.beds;
    const bathsEl = document.getElementById('detail-baths');
    if (bathsEl) bathsEl.textContent = l.baths;
    const sqftEl = document.getElementById('detail-sqft');
    if (sqftEl) sqftEl.textContent = (l.sqft || 0).toLocaleString();
    const typeEl = document.getElementById('detail-type');
    if (typeEl) typeEl.textContent = l.type;
    
    const listedDateEl = document.getElementById('detail-listed-date');
    const daysOldEl = document.getElementById('detail-days-old');
    if (listedDateEl && daysOldEl) {
        const age = listingAge(l.created_at);
        listedDateEl.textContent = age.date;
        daysOldEl.textContent = age.label || 'Listed Date';
    }

    const viewsEl = document.getElementById('detail-views');
    if (viewsEl) viewsEl.textContent = (l.views || 0).toLocaleString('en-IN');

    const reportBtn = document.getElementById('report-listing-btn');
    if (reportBtn) {
        reportBtn.onclick = () => {
            window.openReportModal('listing', l.id, l.title);
        };
    }

    // Description
    const descEl = document.getElementById('detail-desc');
    if (descEl) {
        descEl.innerHTML = `<p>This exquisite ${l.type.toLowerCase()} located in ${l.location} offers a premium living experience with ${l.beds} spacious bedrooms and ${l.baths} modern bathrooms. Spanning ${(l.sqft || 0).toLocaleString()} sqft, the property features high-end finishes, abundant natural light, and breathtaking views.</p>
        <p>Perfect for those seeking luxury and comfort, this home includes state-of-the-art amenities and is situated in a prime neighborhood with easy access to the city's best attractions.</p>`;
    }

    // ── [Photo Overlay Toast] ──
    const photoBtn = Array.from(document.querySelectorAll('span, div')).find((s) => s.textContent.includes('View All 24 Photos'))?.closest('div');
    if (photoBtn) {
        photoBtn.classList.add('cursor-pointer');
        photoBtn.addEventListener('click', () => showToast('Additional photos are demo-only in this build.'));
    }

    // Inquiry vs Chat logic
    const { data: { user } } = await supabase.auth.getUser();
    const role = localStorage.getItem('role');
    
    const form = document.getElementById('buyer-inquiry-form');
    const chatSection = document.getElementById('buyer-chat-section');
    const submitBtn = document.getElementById('contact-agent-btn');

    if (user && role === 'Buyer') {
        if (form) form.classList.add('hidden');
        if (chatSection) {
            chatSection.classList.remove('hidden');
            chatSection.classList.add('flex');
            initBuyerChat(user.id, l.broker_id, l.id, brokerName);
        }
    } else {
        // Fallback to inquiry form for guests/others
        if (form && submitBtn) {
            // Allow Enter key on text inputs (not textarea) to trigger submit
            ['buyer-first-name', 'buyer-last-name', 'buyer-email', 'buyer-phone'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitBtn.click(); });
            });

            submitBtn.onclick = async (e) => {
                e.preventDefault();
                const firstName = document.getElementById('buyer-first-name')?.value?.trim();
                const email = document.getElementById('buyer-email')?.value?.trim();
                const message = document.getElementById('buyer-message')?.value?.trim();

                if (!firstName || !email || !message) {
                    showToast('Please fill in required fields: First Name, Email, and Message.');
                    return;
                }

                if (window.hasProfanity && (window.hasProfanity(firstName) || window.hasProfanity(fullName) || window.hasProfanity(message))) {
                    showToast('WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.', 'profanity');
                    return;
                }

                const phone = document.getElementById('buyer-phone')?.value?.trim();
                const fullName = `${firstName} ${document.getElementById('buyer-last-name')?.value || ''}`.trim();
                const type = document.getElementById('inquiry-type')?.value || 'Inquiry';
                const finalMessage = phone ? `${message} (Contact: ${phone})` : message;

                const { error } = await supabase.from('inquiries').insert([{
                    name: fullName,
                    message: finalMessage,
                    type: type,
                    read: false,
                    listing_id: l.id,
                    broker_id: l.broker_id
                }]);

                if (error) {
                    showToast('Error submitting inquiry: ' + error.message);
                } else {
                    showToast('Inquiry submitted successfully. Broker will contact you soon.');
                    form.reset();
                }
            };
        }
    }
}

let buyerChatChannel = null;
async function initBuyerChat(buyerId, brokerId, listingId, brokerName = 'Broker') {
    activeChatNames[buyerId] = localStorage.getItem('userName') || 'You';
    activeChatNames[brokerId] = brokerName;

    const msgsEl = document.getElementById('buyer-chat-messages');
    const input = document.getElementById('buyer-chat-input');
    const sendBtn = document.getElementById('buyer-chat-send');

    if (!msgsEl || !input || !sendBtn) return;

    if (!buyerId || !brokerId || !listingId) {
        msgsEl.innerHTML = '<div class="text-center text-slate-400 font-medium my-auto absolute inset-0 flex items-center justify-center">Chat is unavailable for this listing (missing broker/buyer details).</div>';
        input.disabled = true;
        sendBtn.disabled = true;
        return;
    }

    msgsEl.innerHTML = '<div class="text-center text-slate-500 my-auto">Loading...</div>';

    const fetchMsgs = async () => {
        const { data: msgs, error } = await supabase
            .from('messages')
            .select('*')
            .eq('buyer_id', buyerId)
            .eq('broker_id', brokerId)
            .eq('listing_id', listingId)
            .order('created_at', { ascending: true });

        if (error) {
            msgsEl.innerHTML = `<div class="text-error">${error.message}</div>`;
            return;
        }

        msgsEl.innerHTML = '';
        if (msgs.length === 0) {
            msgsEl.innerHTML = '<div class="text-center text-slate-400 font-medium my-auto absolute inset-0 flex items-center justify-center">Start a conversation!</div>';
        } else {
            msgs.forEach(m => window.renderMessage(m, buyerId, msgsEl));
            msgsEl.scrollTop = msgsEl.scrollHeight;
        }
    };

    await fetchMsgs();

    sendBtn.onclick = async () => {
        const content = input.value.trim();
        if (!content) return;
        if (window.hasProfanity && window.hasProfanity(content)) {
            showToast('WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.', 'profanity');
            return;
        }
        input.value = '';
        input.disabled = true;
        sendBtn.disabled = true;

        const { error } = await supabase.from('messages').insert([{
            buyer_id: buyerId,
            broker_id: brokerId,
            listing_id: listingId,
            sender_id: buyerId,
            content: content
        }]);

        if (error) showToast('Failed to send message: ' + error.message);

        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
    };

    input.onkeypress = (e) => {
        if (e.key === 'Enter') sendBtn.click();
    };

    if (buyerChatChannel) supabase.removeChannel(buyerChatChannel);
    buyerChatChannel = supabase.channel(`buyer_chat_${buyerId}_${brokerId}_${listingId}`)
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'messages',
            filter: `listing_id=eq.${listingId}` 
        }, payload => {
            if (payload.new.buyer_id === buyerId && payload.new.broker_id === brokerId) {
                if (msgsEl.innerHTML.includes('Start a conversation!')) msgsEl.innerHTML = '';
                window.renderMessage(payload.new, buyerId, msgsEl);
                msgsEl.scrollTop = msgsEl.scrollHeight;
            }
        })
        .subscribe();
}

function initSellPage() {
    const form = document.getElementById('valuation-form');
    if (!form) return;

    form.onsubmit = (e) => {
        e.preventDefault();
        const name = document.getElementById('val-name')?.value?.trim();
        const email = document.getElementById('val-email')?.value?.trim();
        const address = document.getElementById('val-address')?.value?.trim();
        const phone = document.getElementById('val-phone')?.value?.trim();

        if (!name || !email || !address) {
            showToast('Please fill in all required fields.');
            return;
        }

        if (window.hasProfanity && (window.hasProfanity(name) || window.hasProfanity(address) || window.hasProfanity(phone))) {
            showToast('WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.', 'profanity');
            return;
        }

        showToast('Valuation request submitted. Our team will contact you within 24 hours.');
        form.reset();
    };
}

function initAdminPanelInteractions() {
    document.querySelectorAll('button').forEach((button) => {
        const text = button.textContent.trim();
        const title = button.getAttribute('title');
        if (title === 'Approve') {
            button.addEventListener('click', () => {
                button.closest('tr, .flex')?.remove();
                showToast('Broker verification approved.');
            });
        } else if (title === 'Reject') {
            button.addEventListener('click', () => {
                button.closest('tr, .flex')?.remove();
                showToast('Broker verification rejected.');
            });
        } else if (text === 'Load More Queue Items') {
            button.addEventListener('click', () => showToast('All queue items are currently loaded.'));
        } else if (text.includes('View All Users')) {
            button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
        } else if (text.includes('Export')) {
            button.addEventListener('click', () => showToast('Admin report prepared for export.'));
        } else if (text.includes('Invite')) {
            button.addEventListener('click', () => showToast('Invite workflow opened.'));
        }
    });
}

function initEmployeePanelInteractions() {
    document.querySelectorAll('button').forEach((button) => {
        const text = button.textContent.trim();
        if (text === 'Approve') {
            button.addEventListener('click', () => {
                button.closest('article, div')?.classList.add('opacity-60');
                showToast('Listing approved.');
            });
        } else if (text === 'Flag') {
            button.addEventListener('click', () => showToast('Listing flagged for review.'));
        } else if (text === 'Remove') {
            button.addEventListener('click', () => {
                button.closest('article, div')?.remove();
                showToast('Listing removed from queue.');
            });
        } else if (text === 'View All') {
            button.addEventListener('click', () => showToast('All assigned items are visible.'));
        }
    });
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function listingAge(createdAt) {
    if (!createdAt) return { date: '—', days: null, label: '' };
    const created = new Date(createdAt);
    const diffTime = Date.now() - created.getTime();
    const days = Math.max(0, Math.floor(diffTime / 86400000));
    const date = created.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    const label = days === 0 ? 'Today' : days === 1 ? '1 day old' : `${days} days old`;
    return { date, days, label };
}

// ─── Global Navbar Search ─────────────────────────────────────────────────────
document.querySelectorAll('input[placeholder="Search..."]').forEach(input => {
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const query = e.target.value.trim();
            if (query) {
                // If we are already on properties page, just fill the local search and trigger click
                if (window.location.pathname.includes('properties.html')) {
                    const pageSearch = document.getElementById('listing-search-input');
                    const btn = document.getElementById('find-homes-btn');
                    if (pageSearch && btn) {
                        pageSearch.value = query;
                        btn.click();
                        return;
                    }
                }
                // Otherwise navigate to properties page
                navigateTo(`properties.html?q=${encodeURIComponent(query)}`);
            }
        }
    });

    // ── Global Buyer Welcome Modal ──
    if (userRole === 'Buyer' && !isLoginPage) {
        const showWelcome = localStorage.getItem('showWelcome');
        if (showWelcome) {
            // Clear immediately so it never appears again, even if user navigates away without clicking
            localStorage.removeItem('showWelcome');

            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 z-[999] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 opacity-0 transition-opacity duration-500';
            modal.innerHTML = `
                <div class="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl transform scale-95 transition-transform duration-500 text-center">
                    <div class="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
                        <span class="material-symbols-outlined text-4xl">celebration</span>
                    </div>
                    <h2 class="text-3xl font-black text-slate-900 mb-2 tracking-tight">Welcome, ${showWelcome}!</h2>
                    <p class="text-slate-500 mb-8 font-medium">Your buyer account is ready. Explore premium properties, save your favorites, and contact top brokers instantly.</p>
                    <button id="close-welcome" class="w-full bg-slate-900 text-white py-4 rounded-xl font-black uppercase tracking-widest text-xs hover:bg-slate-800 transition-colors shadow-lg active:scale-[0.98]">
                        Start Exploring
                    </button>
                </div>
            `;
            document.body.appendChild(modal);
            
            // Small delay so CSS transition plays correctly on first paint
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    modal.classList.remove('opacity-0');
                    modal.querySelector('div').classList.remove('scale-95');
                });
            });

            document.getElementById('close-welcome').onclick = () => {
                modal.classList.add('opacity-0');
                modal.querySelector('div').classList.add('scale-95');
                setTimeout(() => modal.remove(), 400);
            };
        }
    }
});

// ─── Realtime Chat Logic ─────────────────────────────────────────────────────
const unreadConversations = new Set();

function updateSidebarMessagesBadge() {
    const badge = document.getElementById('unread-messages-badge');
    if (badge) {
        const count = unreadConversations.size;
        if (count > 0) {
            badge.textContent = count;
            badge.classList.remove('hidden');
            badge.classList.add('inline-block');
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('inline-block');
        }
    }
}

let currentChatConversation = null;
let chatChannel = null;
let activeChatNames = {};

window.initBrokerChat = async function initBrokerChat() {
    const listEl = document.getElementById('chat-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="p-4 text-center text-slate-500 font-medium">Loading conversations...</div>';

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: messages, error } = await supabase
        .from('messages')
        .select('buyer_id, listing_id, created_at')
        .eq('broker_id', user.id)
        .order('created_at', { ascending: false });

    if (error) {
        listEl.innerHTML = `<div class="p-4 text-error">${error.message}</div>`;
        return;
    }

    const uniqueMap = new Map();
    messages?.forEach(m => {
        const key = `${m.buyer_id}-${m.listing_id}`;
        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, m);
        }
    });

    const uniqueConversations = Array.from(uniqueMap.values());

    if (uniqueConversations.length === 0) {
        listEl.innerHTML = '<div class="p-4 text-center text-slate-500 font-medium">No conversations yet.</div>';
        return;
    }

    // Fetch listing titles and buyer profiles
    const buyerIds = [...new Set(uniqueConversations.map(c => c.buyer_id))];
    const listingIds = [...new Set(uniqueConversations.map(c => c.listing_id))];

    const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', buyerIds);
    const { data: listings } = await supabase.from('listings').select('id, title').in('id', listingIds);

    profiles?.forEach(p => {
        activeChatNames[p.id] = p.full_name;
    });
    activeChatNames[user.id] = localStorage.getItem('userName') || 'You';

    listEl.innerHTML = '';
    uniqueConversations.forEach(c => {
        const buyer = profiles?.find(p => p.id === c.buyer_id);
        const listing = listings?.find(l => l.id === c.listing_id);
        const name = buyer?.full_name || 'Buyer';
        const letter = name.charAt(0).toUpperCase();
        
        // Premium HSL matching palette
        const colors = [
            'bg-slate-900 text-white',
            'bg-indigo-900 text-indigo-100',
            'bg-blue-900 text-blue-100',
            'bg-emerald-900 text-emerald-100',
            'bg-teal-900 text-teal-100'
        ];
        const colorIdx = (name.charCodeAt(0) || 0) % colors.length;
        const colorClass = colors[colorIdx];

        const conversationKey = `${c.buyer_id}-${c.listing_id}`;
        const isUnread = unreadConversations.has(conversationKey);

        const div = document.createElement('div');
        div.className = `p-4 border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-all flex items-center gap-3 group relative ${isUnread ? 'bg-red-50/20' : ''}`;
        div.innerHTML = `
            <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${colorClass} shrink-0 shadow-sm group-hover:scale-105 transition-transform duration-200">
                ${letter}
            </div>
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <div class="font-bold text-slate-800 text-sm truncate group-hover:text-slate-900 transition-colors">${escHtml(name)}</div>
                    ${isUnread ? `<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" title="Unread message"></span>` : ''}
                </div>
                <div class="text-xs text-slate-400 font-medium mt-0.5 truncate flex items-center gap-1">
                    <span class="material-symbols-outlined text-[14px] text-slate-300">domain</span>
                    ${escHtml(listing?.title || 'Property')}
                </div>
            </div>
            <span class="material-symbols-outlined text-slate-300 text-[16px] opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all duration-300">chevron_right</span>
        `;
        div.onclick = () => {
            unreadConversations.delete(conversationKey);
            updateSidebarMessagesBadge();
            div.classList.remove('bg-red-50/20');
            const dot = div.querySelector('.bg-red-500');
            if (dot) dot.remove();
            window.loadChatMessages(c.buyer_id, user.id, c.listing_id, name, listing?.title || 'Property');
        };
        listEl.appendChild(div);
    });
};

window.loadChatMessages = async function loadChatMessages(buyerId, brokerId, listingId, buyerName, listingTitle) {
    currentChatConversation = { buyerId, brokerId, listingId };
    activeChatNames[buyerId] = buyerName;
    activeChatNames[brokerId] = localStorage.getItem('userName') || 'You';
    
    document.getElementById('chat-header').innerHTML = `
        <div>
            <a href="/profile.html?id=${buyerId}" target="_blank" class="text-lg font-bold text-slate-900 hover:text-slate-600 transition-colors flex items-center gap-1.5 hover:underline">
                ${escHtml(buyerName)}
                <span class="material-symbols-outlined text-[18px]">open_in_new</span>
            </a>
            <div class="text-xs font-medium text-slate-500">${listingTitle}</div>
        </div>
    `;

    const msgsEl = document.getElementById('chat-messages');

    if (!buyerId || !brokerId || !listingId) {
        msgsEl.innerHTML = '<div class="text-center text-error mt-4 font-medium">Invalid chat details (missing broker or buyer).</div>';
        return;
    }

    msgsEl.innerHTML = '<div class="text-center text-slate-500 mt-4 font-medium">Loading messages...</div>';

    const { data: { user } } = await supabase.auth.getUser();

    const fetchMsgs = async () => {
        const { data: msgs, error } = await supabase
            .from('messages')
            .select('*')
            .eq('buyer_id', buyerId)
            .eq('broker_id', brokerId)
            .eq('listing_id', listingId)
            .order('created_at', { ascending: true });

        if (error) {
            msgsEl.innerHTML = `<div class="text-error">Error: ${error.message}</div>`;
            return;
        }

        msgsEl.innerHTML = '';
        if (msgs.length === 0) {
            msgsEl.innerHTML = '<div class="text-center text-slate-400 mt-10 font-medium">No messages yet. Say hi!</div>';
        } else {
            msgs.forEach(m => window.renderMessage(m, user.id, msgsEl));
            msgsEl.scrollTop = msgsEl.scrollHeight;
        }
    };

    await fetchMsgs();

    // Enable input
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    input.disabled = false;
    sendBtn.disabled = false;

    sendBtn.onclick = async () => {
        const content = input.value.trim();
        if (!content) return;
        if (window.hasProfanity && window.hasProfanity(content)) {
            showToast('WARNING: Swearing is strictly prohibited! Please remove all offensive language to proceed.', 'profanity');
            return;
        }
        input.value = '';
        input.disabled = true;
        sendBtn.disabled = true;

        const { error } = await supabase.from('messages').insert([{
            buyer_id: buyerId,
            broker_id: brokerId,
            listing_id: listingId,
            sender_id: user.id,
            content: content
        }]);

        if (error) showToast('Failed to send message: ' + error.message);

        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
    };

    input.onkeypress = (e) => {
        if (e.key === 'Enter') sendBtn.click();
    };

    // Set up real-time listener
    if (chatChannel) supabase.removeChannel(chatChannel);

    chatChannel = supabase.channel(`chat_${buyerId}_${brokerId}_${listingId}`)
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'messages',
            filter: `listing_id=eq.${listingId}` 
        }, payload => {
            // Need to make sure it belongs to this conversation
            if (payload.new.buyer_id === buyerId && payload.new.broker_id === brokerId) {
                // If it was the first message, clear the "No messages yet" text
                if (msgsEl.innerHTML.includes('No messages yet')) msgsEl.innerHTML = '';
                window.renderMessage(payload.new, user.id, msgsEl);
                msgsEl.scrollTop = msgsEl.scrollHeight;
            }
        })
        .subscribe();
};

function formatMsgTime(dateStr) {
    if (!dateStr) return 'Just now';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Just now';
    
    const now = new Date();
    const diffMs = now - d;
    if (diffMs < 30000) return 'Just now'; // less than 30s
    
    const timeOptions = { hour: '2-digit', minute: '2-digit', hour12: true };
    const dateOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
    
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], timeOptions);
    }
    
    return d.toLocaleDateString([], dateOptions);
}

window.renderMessage = function renderMessage(m, currentUserId, container) {
    const isMe = m.sender_id === currentUserId;
    const senderName = isMe ? 'You' : (activeChatNames[m.sender_id] || 'Buyer');
    const timeStr = formatMsgTime(m.created_at);

    const msgWrapper = document.createElement('div');
    msgWrapper.className = `flex flex-col gap-1 w-full ${isMe ? 'items-end' : 'items-start'}`;

    // Premium header
    const header = document.createElement('div');
    header.className = 'flex items-center gap-1.5 px-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest';
    
    let senderHTML = `<span>${escHtml(senderName)}</span>`;
    if (!isMe && m.sender_id) {
        senderHTML = `<a href="/profile.html?id=${m.sender_id}" target="_blank" class="hover:text-slate-800 hover:underline flex items-center gap-0.5 transition-colors">
            ${escHtml(senderName)}
            <span class="material-symbols-outlined text-[10px] inline-block font-normal">open_in_new</span>
        </a>`;
    }
    
    header.innerHTML = `${senderHTML}<span class="text-[8px] text-slate-300">•</span><span>${timeStr}</span>`;

    // Bubble
    const bubble = document.createElement('div');
    bubble.className = `max-w-[75%] px-4 py-3 rounded-2xl text-sm font-medium shadow-sm transition-all duration-200 hover:shadow-md ${
        isMe 
        ? 'bg-slate-900 text-white rounded-tr-none border border-slate-800' 
        : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none'
    }`;
    bubble.textContent = m.content;

    msgWrapper.appendChild(header);
    msgWrapper.appendChild(bubble);
    container.appendChild(msgWrapper);
};

// ─── AJAX Single Page Application (SPA) Router ──────────────────────────────

// Dynamic CSS injection for transitions
const style = document.createElement('style');
style.id = 'spa-transition-style';
style.innerHTML = `
    body {
        opacity: 1;
    }
    body.spa-fade {
        transition: opacity 0.15s ease-in-out;
    }
    body.spa-hidden {
        opacity: 0 !important;
    }
`;
document.head.appendChild(style);

let isNavigating = false;

// Global page initialization registry for SPA pages
window.spaPageInit = window.spaPageInit || {};
window.initAppPageHasRun = false;
window.registerPageInit = function(pageName, initFn) {
    window.spaPageInit[pageName] = initFn;
    
    // Resolve current computed page to match pageName
    const currentPath = window.location.pathname;
    let computedPage = currentPath.split('/').pop() || 'index.html';
    const isSharedFilterRoute = currentPath.includes('/shared-filter/') || computedPage === 'shared-filter';
    if (isSharedFilterRoute) {
        computedPage = 'shared-filter.html';
    } else if (!computedPage.includes('.')) {
        computedPage += '.html';
    }
    
    // If the main initAppPage has already run for this page, execute immediately
    if (window.initAppPageHasRun && computedPage === pageName) {
        try {
            initFn();
        } catch (e) {
            console.error(`Error running SPA page initializer for ${pageName}:`, e);
        }
    }
};

async function ajaxLoadPage(url, replaceState = false) {
    if (isNavigating) return;
    isNavigating = true;
    window.initAppPageHasRun = false;

    // Create or find Progress Bar
    let progressBar = document.getElementById('spa-progress-bar');
    if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.id = 'spa-progress-bar';
        progressBar.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg, #0f172a, #3b82f6, #0f172a);z-index:99999;width:0%;transition:width 0.2s ease, opacity 0.2s ease;';
        document.body.appendChild(progressBar);
    }
    progressBar.style.opacity = '1';
    progressBar.style.width = '0%';
    setTimeout(() => { if (isNavigating) progressBar.style.width = '30%'; }, 50);
    setTimeout(() => { if (isNavigating) progressBar.style.width = '60%'; }, 200);

    // Fade out current body
    document.body.classList.add('spa-fade', 'spa-hidden');

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

        const htmlText = await response.text();

        // Parse HTML
        const parser = new DOMParser();
        const parsedDoc = parser.parseFromString(htmlText, 'text/html');

        // Progress update
        progressBar.style.width = '90%';

        // Wait a tiny bit for the fade-out transition to finish
        await new Promise(resolve => setTimeout(resolve, 150));

        // Sync head elements (CSS and scripts, wait for scripts to load)
        await syncHead(parsedDoc);

        // Swap body classes and content
        document.body.className = parsedDoc.body.className;
        document.body.innerHTML = parsedDoc.body.innerHTML;

        // Update title and history
        document.title = parsedDoc.title || document.title;
        if (replaceState) {
            history.replaceState({ url }, '', url);
        } else {
            history.pushState({ url }, '', url);
        }

        // Force execution of script tags in the new body
        executeScripts(document.body);

        // Re-run the page initialization lifecycle
        initAppPage();

        // Scroll management
        if (url.includes('#')) {
            const hash = url.substring(url.indexOf('#'));
            const targetEl = document.querySelector(hash);
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth' });
            } else {
                window.scrollTo(0, 0);
            }
        } else {
            window.scrollTo(0, 0);
        }

        // Finish progress bar
        progressBar.style.width = '100%';
        setTimeout(() => {
            progressBar.style.opacity = '0';
            setTimeout(() => { progressBar.style.width = '0%'; }, 200);
        }, 150);

    } catch (error) {
        console.error('SPA navigation failed, reloading page natively:', error);
        window.location.href = url;
    } finally {
        isNavigating = false;
        // Fade in new body
        requestAnimationFrame(() => {
            document.body.classList.remove('spa-hidden');
            // Remove spa-fade after transition completes to prevent hover lag or side effects
            setTimeout(() => {
                document.body.classList.remove('spa-fade');
            }, 150);
        });
    }
}

async function syncHead(parsedDoc) {
    const currentHead = document.head;
    const newHead = parsedDoc.head;

    // 1. Sync Stylesheets
    const newStylesheets = Array.from(newHead.querySelectorAll('link[rel="stylesheet"]'));
    newStylesheets.forEach(link => {
        const href = link.getAttribute('href');
        if (href && !currentHead.querySelector(`link[href="${href}"]`)) {
            const newLink = document.createElement('link');
            Array.from(link.attributes).forEach(attr => {
                newLink.setAttribute(attr.name, attr.value);
            });
            currentHead.appendChild(newLink);
        }
    });

    // 2. Load and wait for external scripts in the head (excluding auth.js)
    const newScripts = Array.from(newHead.querySelectorAll('script[src]'));
    const loadPromises = [];

    newScripts.forEach(script => {
        const src = script.getAttribute('src');
        if (src) {
            if (src.includes('auth.js')) return; // ignore auth.js
            
            // If it's not already loaded
            if (!currentHead.querySelector(`script[src="${src}"]`)) {
                const newScript = document.createElement('script');
                Array.from(script.attributes).forEach(attr => {
                    newScript.setAttribute(attr.name, attr.value);
                });

                const promise = new Promise((resolve) => {
                    newScript.onload = () => resolve();
                    newScript.onerror = () => {
                        console.warn(`Failed to load script: ${src}`);
                        resolve(); // Resolve to avoid hanging the app
                    };
                });
                loadPromises.push(promise);
                currentHead.appendChild(newScript);
            }
        }
    });

    // 3. Run inline head scripts
    const inlineHeadScripts = Array.from(newHead.querySelectorAll('script:not([src])'));
    inlineHeadScripts.forEach(script => {
        const newScript = document.createElement('script');
        newScript.textContent = script.textContent;
        currentHead.appendChild(newScript);
    });

    if (loadPromises.length > 0) {
        await Promise.all(loadPromises);
    }
}

function executeScripts(container) {
    const scripts = Array.from(container.querySelectorAll('script'));
    scripts.forEach(oldScript => {
        const src = oldScript.getAttribute('src');
        if (src && src.includes('auth.js')) return; // ignore auth.js
        
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(attr => {
            newScript.setAttribute(attr.name, attr.value);
        });

        if (oldScript.src) {
            newScript.src = oldScript.src;
        } else {
            newScript.textContent = oldScript.textContent;
        }

        oldScript.parentNode.replaceChild(newScript, oldScript);
    });
}

// Global Click Interception
document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;

    // Ignore special clicks
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;

    const href = link.getAttribute('href');
    if (!href) return;

    // Ignore javascript, mailto, tel, and same-page anchor tags
    if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (href.startsWith('#')) return;
    if (link.getAttribute('target') === '_blank') return;
    if (link.hasAttribute('data-no-ajax')) return;

    // Verify it is an internal page
    const targetUrl = new URL(href, window.location.href);
    if (targetUrl.origin !== window.location.origin) return;

    e.preventDefault();
    ajaxLoadPage(targetUrl.href);
});

// History popstate handling
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.url) {
        ajaxLoadPage(e.state.url, true);
    } else {
        ajaxLoadPage(window.location.href, true);
    }
});

// Initialize first history state
if (!history.state) {
    history.replaceState({ url: window.location.href }, '', window.location.href);
}

// Expose loader to global window scope
window.ajaxLoadPage = ajaxLoadPage;

// ─── Reporting & Flagging System ──────────────────────────────────────────────
function injectReportModal() {
    if (document.getElementById('report-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'report-modal';
    modal.className = 'hidden fixed inset-0 z-[100] items-center justify-center bg-black/50 backdrop-blur-sm';
    modal.innerHTML = `
      <div class="bg-white rounded-[32px] shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-slate-100 font-sans">
        <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div>
            <h3 class="text-lg font-black text-slate-900">Report Issue</h3>
            <p class="text-xs text-slate-500 mt-0.5">Help us maintain platform integrity.</p>
          </div>
          <button onclick="closeReportModal()" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-900 rounded-full hover:bg-slate-100 transition-colors">
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div class="p-6 space-y-4">
          <input type="hidden" id="report-target-type"/>
          <input type="hidden" id="report-target-id"/>
          
          <div>
            <span class="text-[10px] font-black uppercase tracking-widest text-slate-400">Target Item</span>
            <p id="report-target-name" class="text-sm font-bold text-slate-900 mt-1 truncate">—</p>
          </div>
          
          <div>
            <label class="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Reason for Report *</label>
            <select id="report-reason" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 outline-none focus:border-slate-900 transition-all">
              <option value="" disabled selected>Select a reason...</option>
              <option value="Fraudulent/Misleading Content">Fraudulent/Misleading Content</option>
              <option value="Inappropriate/Offensive Content">Inappropriate/Offensive Content</option>
              <option value="Spam or Harassment">Spam or Harassment</option>
              <option value="Abusive Behavior">Abusive Behavior</option>
              <option value="Other">Other</option>
            </select>
          </div>
          
          <div>
            <label class="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Additional Details *</label>
            <textarea id="report-description" placeholder="Please describe the issue in detail..." rows="4" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900 transition-all resize-none"></textarea>
          </div>
          
          <button onclick="submitReportForm()" id="submit-report-btn" class="w-full bg-slate-900 text-white py-3.5 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-colors mt-2">
            Submit Report
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeReportModal(); });
}

window.closeReportModal = function() {
    const modal = document.getElementById('report-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

window.openReportModal = async function(targetType, targetId, targetName) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        showToast('Please sign in to file a report.', true);
        window.location.href = '/login.html';
        return;
    }
    
    injectReportModal();
    
    document.getElementById('report-target-type').value = targetType;
    document.getElementById('report-target-id').value = targetId;
    document.getElementById('report-target-name').textContent = targetName;
    document.getElementById('report-reason').value = '';
    document.getElementById('report-description').value = '';
    
    const modal = document.getElementById('report-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

window.submitReportForm = async function() {
    const targetType = document.getElementById('report-target-type').value;
    const targetId = document.getElementById('report-target-id').value;
    const reason = document.getElementById('report-reason').value;
    const description = document.getElementById('report-description').value.trim();
    const btn = document.getElementById('submit-report-btn');

    if (!reason) {
        showToast('Please select a reason for your report.', true);
        return;
    }
    if (!description) {
        showToast('Please provide some details for the report.', true);
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated.');

        const { error } = await supabase.from('reports').insert([{
            reporter_id: user.id,
            target_type: targetType,
            target_id: targetId,
            reason: reason,
            description: description
        }]);

        if (error) throw error;

        showToast('✓ Thank you. Your report has been submitted.');
        closeReportModal();
    } catch (err) {
        console.error(err);
        showToast(err.message || 'Failed to submit report.', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Submit Report';
    }
};

async function logListingStatusChange(listingId, oldStatus, newStatus, reason) {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const userId = session && session.user ? session.user.id : null;
        const { error } = await supabase.from('listing_status_history').insert([{
            listing_id: listingId,
            changed_by: userId,
            old_status: oldStatus,
            new_status: newStatus,
            reason: reason || 'No remarks provided.'
        }]);
        if (error) console.error('Error logging status change:', error.message);
    } catch (err) {
        console.error('Failed to log listing status change:', err);
    }
}

async function sendBrokerNotification(brokerId, listingTitle, oldStatus, newStatus, reason) {
    try {
        if (!brokerId) return;
        const msg = `Your listing "${listingTitle}" status has been updated from "${oldStatus || 'None'}" to "${newStatus === 'Active' ? 'Approved' : newStatus}".${reason ? ` Reason: ${reason}` : ''}`;
        const { error } = await supabase.from('notifications').insert([{
            user_id: brokerId,
            title: 'Listing Status Update',
            message: msg,
            read: false
        }]);
        if (error) console.error('Error sending broker notification:', error.message);
    } catch (err) {
        console.error('Failed to send broker notification:', err);
    }
}

async function updateSidebarNotificationsBadge() {
    const badge = document.getElementById('unread-notifications-badge');
    const mobileBadge = document.getElementById('mobile-unread-notifications-badge');
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session || !session.user) return;
        const { count, error } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', session.user.id)
            .eq('read', false);
        
        if (error) {
            console.error('Error fetching unread notification count:', error.message);
            return;
        }

        if (badge) {
            if (count > 0) {
                badge.textContent = count;
                badge.classList.remove('hidden');
                badge.classList.add('inline-block');
            } else {
                badge.classList.add('hidden');
                badge.classList.remove('inline-block');
            }
        }
        if (mobileBadge) {
            if (count > 0) {
                mobileBadge.textContent = count;
                mobileBadge.classList.remove('hidden');
                mobileBadge.classList.add('flex');
            } else {
                mobileBadge.classList.add('hidden');
                mobileBadge.classList.remove('flex');
            }
        }
    } catch (err) {
        console.error('Failed to update notifications badge:', err);
    }
}

async function initNotificationsManager() {
    const listContainer = document.getElementById('notifications-list-container');
    if (!listContainer) return;

    const markAllReadBtn = document.getElementById('mark-all-read-btn');
    
    const renderNotifications = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session || !session.user) return;
            const userId = session.user.id;

            const { data: notifications, error } = await supabase
                .from('notifications')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false });

            if (error) {
                listContainer.innerHTML = `<div class="text-error font-medium py-4 text-center">Error loading notifications: ${error.message}</div>`;
                return;
            }

            if (!notifications || notifications.length === 0) {
                listContainer.innerHTML = `
                    <div class="text-center text-slate-400 py-10 font-medium flex flex-col items-center gap-2">
                        <span class="material-symbols-outlined text-[40px] text-slate-300">notifications_off</span>
                        <span>No notifications yet.</span>
                    </div>`;
                return;
            }

            listContainer.innerHTML = notifications.map(notif => {
                const dateStr = notif.created_at ? new Date(notif.created_at).toLocaleString('en-IN') : '—';
                const unreadClass = notif.read ? 'bg-white opacity-80 border-slate-100' : 'bg-slate-50/70 border-primary-container border-l-4 ring-1 ring-primary-container/20';
                return `
                    <div class="p-4 rounded-xl border transition-all ${unreadClass} flex flex-col md:flex-row justify-between items-start md:items-center gap-4" data-id="${notif.id}">
                        <div class="flex-1">
                            <div class="flex items-center gap-2 mb-1">
                                <span class="material-symbols-outlined text-[18px] text-primary">${notif.read ? 'notifications' : 'notifications_active'}</span>
                                <h4 class="font-bold text-slate-900 text-sm">${notif.title || 'Notification'}</h4>
                                ${notif.read ? '' : '<span class="bg-primary text-on-primary text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider">New</span>'}
                            </div>
                            <p class="text-xs md:text-sm text-slate-600 font-medium">${notif.message || ''}</p>
                            <span class="text-[10px] text-slate-400 font-normal mt-2 block">${dateStr}</span>
                        </div>
                        ${notif.read ? '' : `
                            <button class="mark-single-read-btn text-xs font-semibold text-primary hover:underline flex items-center gap-1 whitespace-nowrap bg-surface-container-low px-3 py-1.5 rounded-lg border border-outline-variant hover:bg-surface-container-high transition-colors" data-id="${notif.id}">
                                <span class="material-symbols-outlined text-[14px]">done</span>
                                Mark read
                            </button>
                        `}
                    </div>
                `;
            }).join('');

            // Wire up single read buttons
            listContainer.querySelectorAll('.mark-single-read-btn').forEach(btn => {
                btn.onclick = async () => {
                    const id = btn.dataset.id;
                    const { error } = await supabase.from('notifications').update({ read: true }).eq('id', id);
                    if (error) {
                        showToast('Error marking notification as read: ' + error.message, true);
                    } else {
                        await renderNotifications();
                        await updateSidebarNotificationsBadge();
                    }
                };
            });

        } catch (err) {
            console.error('Failed to render notifications:', err);
            listContainer.innerHTML = `<div class="text-error font-medium py-4 text-center">Failed to load notifications.</div>`;
        }
    };

    if (markAllReadBtn) {
        markAllReadBtn.onclick = async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session || !session.user) return;
                const { error } = await supabase
                    .from('notifications')
                    .update({ read: true })
                    .eq('user_id', session.user.id)
                    .eq('read', false);

                if (error) {
                    showToast('Error marking notifications as read: ' + error.message, true);
                } else {
                    showToast('All notifications marked as read.');
                    await renderNotifications();
                    await updateSidebarNotificationsBadge();
                }
            } catch (err) {
                console.error(err);
            }
        };
    }

    await renderNotifications();
    await updateSidebarNotificationsBadge();

    // Set up realtime channel for new notifications
    const { data: { session } } = await supabase.auth.getSession();
    if (session && session.user) {
        supabase.channel(`broker_notifications_${session.user.id}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${session.user.id}`
            }, async () => {
                const notifTab = document.getElementById('tab-notifications');
                if (notifTab && !notifTab.classList.contains('hidden')) {
                    await renderNotifications();
                } else {
                    await updateSidebarNotificationsBadge();
                }
            })
            .subscribe();
    }
}

window.logListingStatusChange = logListingStatusChange;
window.sendBrokerNotification = sendBrokerNotification;
window.updateSidebarNotificationsBadge = updateSidebarNotificationsBadge;
window.initNotificationsManager = initNotificationsManager;


