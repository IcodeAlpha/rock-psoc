import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  organizationId: string | null;
  userRole: 'admin' | 'analyst' | 'viewer' | null;
  signUp: (email: string, password: string, fullName: string, orgName: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<'admin' | 'analyst' | 'viewer' | null>(null);

  const fetchUserOrgAndRole = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('organization_members')
        .select('organization_id, role')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('Error fetching org membership:', error);
        return;
      }

      if (data) {
        setOrganizationId(data.organization_id);
        setUserRole(data.role as 'admin' | 'analyst' | 'viewer');
      }
    } catch (err) {
      console.error('Error in fetchUserOrgAndRole:', err);
    }
  };

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        setLoading(false);

        // Defer Supabase calls with setTimeout
        if (session?.user) {
          setTimeout(() => {
            fetchUserOrgAndRole(session.user.id);
          }, 0);
        } else {
          setOrganizationId(null);
          setUserRole(null);
        }
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      
      if (session?.user) {
        fetchUserOrgAndRole(session.user.id);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, fullName: string, orgName: string) => {
    try {
      const redirectUrl = `${window.location.origin}/`;

      // STEP 1: Sign up the user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectUrl,
          data: {
            full_name: fullName
          }
        }
      });

      if (authError) {
        console.error('Auth error:', authError);
        return { error: authError };
      }

      if (!authData.user || !authData.session) {
        return { error: new Error('Failed to create user session') };
      }

      console.log('User created successfully:', authData.user.id);

      // STEP 2: Wait for profile trigger to complete (CRITICAL!)
      console.log('Waiting for profile creation...');
      await new Promise(resolve => setTimeout(resolve, 2000)); // Increased to 2 seconds

      // STEP 3: Create organization slug
      const orgSlug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .substring(0, 50);

      // Add timestamp to ensure uniqueness
      const uniqueSlug = `${orgSlug}-${Date.now().toString(36)}`;

      console.log('Creating organization:', { name: orgName, slug: uniqueSlug });

      // STEP 4: Create the organization
      const { data: orgData, error: orgError } = await supabase
        .from('organizations')
        .insert({ 
          name: orgName, 
          slug: uniqueSlug 
        })
        .select()
        .single();

      if (orgError) {
        console.error('Organization creation error:', {
          message: orgError.message,
          details: orgError.details,
          hint: orgError.hint,
          code: orgError.code
        });

        // Better error messages based on error code
        if (orgError.code === '42501') {
          return { error: new Error('Permission denied. Please try signing in again.') };
        } else if (orgError.code === '23505') {
          return { error: new Error('Organization name already exists. Please choose another.') };
        } else if (orgError.code === '23503') {
          return { error: new Error('User profile not ready. Please try again.') };
        }
        
        return { error: new Error(`Failed to create organization: ${orgError.message}`) };
      }

      if (!orgData) {
        return { error: new Error('Organization created but no data returned') };
      }

      console.log('Organization created:', orgData.id);

      // STEP 5: Add user as admin of the organization
      const { error: memberError } = await supabase
        .from('organization_members')
        .insert({
          organization_id: orgData.id,
          user_id: authData.user.id,
          role: 'admin'
        });

      if (memberError) {
        console.error('Member creation error:', {
          message: memberError.message,
          details: memberError.details,
          hint: memberError.hint,
          code: memberError.code
        });
        
        return { error: new Error(`Failed to add user to organization: ${memberError.message}`) };
      }

      console.log('User added to organization as admin');

      // STEP 6: Update local state immediately
      setOrganizationId(orgData.id);
      setUserRole('admin');

      return { error: null };
    } catch (err) {
      console.error('Unexpected signup error:', err);
      return { error: err as Error };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password
      });
      return { error };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setOrganizationId(null);
    setUserRole(null);
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      loading,
      organizationId,
      userRole,
      signUp,
      signIn,
      signOut
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};