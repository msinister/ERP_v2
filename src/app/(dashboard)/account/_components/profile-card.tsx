'use client';

import { useState, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Camera, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { UserAvatar } from '@/components/user-menu';
import { toast } from '@/lib/toast';

type Profile = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  phone: string | null;
  title: string | null;
  department: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  role: { name: string } | null;
};

const profileSchema = z.object({
  name: z.string().min(1, 'Required').max(255),
  phone: z.string().max(50).optional(),
  title: z.string().max(255).optional(),
  department: z.string().max(255).optional(),
});

const emailSchema = z.object({
  email: z.string().email('Must be a valid email').max(255),
});

type ProfileForm = z.infer<typeof profileSchema>;
type EmailForm = z.infer<typeof emailSchema>;

function getInitials(name: string, email: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return (email?.[0] ?? '?').toUpperCase();
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export function ProfileCard({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(profile.image);
  const [avatarPending, startAvatarTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const profileForm = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: profile.name ?? '',
      phone: profile.phone ?? '',
      title: profile.title ?? '',
      department: profile.department ?? '',
    },
  });

  const emailForm = useForm<EmailForm>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: profile.email ?? '' },
  });

  async function saveProfile(data: ProfileForm) {
    const res = await fetch('/api/me/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: data.name,
        phone: data.phone || null,
        title: data.title || null,
        department: data.department || null,
      }),
    });
    if (!res.ok) {
      toast.error('Failed to save profile');
      return;
    }
    toast.success('Profile updated');
    router.refresh();
  }

  async function saveEmail(data: EmailForm) {
    const res = await fetch('/api/me/email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: data.email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body?.error === 'email_taken') {
        emailForm.setError('email', { message: 'Email already in use' });
      } else {
        toast.error('Failed to update email');
      }
      return;
    }
    toast.success('Email updated');
    router.refresh();
  }

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      if (dataUrl.length > 512_000) {
        toast.error('Image is too large. Please use an image under ~300 KB.');
        return;
      }
      startAvatarTransition(async () => {
        const res = await fetch('/api/me/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast.error(body?.issues?.[0]?.message ?? 'Failed to upload avatar');
          return;
        }
        setAvatarDataUrl(dataUrl);
        toast.success('Avatar updated');
        router.refresh();
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function removeAvatar() {
    startAvatarTransition(async () => {
      const res = await fetch('/api/me/avatar', { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to remove avatar');
        return;
      }
      setAvatarDataUrl(null);
      toast.success('Avatar removed');
      router.refresh();
    });
  }

  const display = profile.name?.trim() ? profile.name : profile.email;
  const initials = getInitials(profile.name ?? '', profile.email);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Avatar */}
        <div className="flex items-center gap-4">
          <UserAvatar
            name={display}
            image={avatarDataUrl}
            initials={initials}
            size="md"
          />
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={avatarPending}
                onClick={() => fileRef.current?.click()}
              >
                <Camera className="size-3.5" />
                {avatarDataUrl ? 'Change photo' : 'Upload photo'}
              </Button>
              {avatarDataUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={avatarPending}
                  onClick={removeAvatar}
                >
                  <Trash2 className="size-3.5" />
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">JPG, PNG or WebP, max ~300 KB</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleAvatarChange}
          />
        </div>

        {/* Profile fields */}
        <form onSubmit={profileForm.handleSubmit(saveProfile)} className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel>Full name</FieldLabel>
              <Input {...profileForm.register('name')} placeholder="Your name" />
              <FieldError>{profileForm.formState.errors.name?.message}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Phone</FieldLabel>
              <Input {...profileForm.register('phone')} placeholder="+1 555 000 0000" />
              <FieldError>{profileForm.formState.errors.phone?.message}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Title / role</FieldLabel>
              <Input {...profileForm.register('title')} placeholder="e.g. Sales Manager" />
              <FieldError>{profileForm.formState.errors.title?.message}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Department</FieldLabel>
              <Input {...profileForm.register('department')} placeholder="e.g. Operations" />
              <FieldError>{profileForm.formState.errors.department?.message}</FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={profileForm.formState.isSubmitting || !profileForm.formState.isDirty}
            >
              Save profile
            </Button>
          </div>
        </form>

        {/* Email — separate form so password change isn't tied to profile save */}
        <div className="border-t pt-4">
          <p className="mb-3 text-sm font-medium">Email address</p>
          <form onSubmit={emailForm.handleSubmit(saveEmail)} className="space-y-3">
            <Field>
              <Input
                type="email"
                {...emailForm.register('email')}
                placeholder="you@example.com"
              />
              <FieldError>{emailForm.formState.errors.email?.message}</FieldError>
            </Field>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                disabled={emailForm.formState.isSubmitting || !emailForm.formState.isDirty}
              >
                Update email
              </Button>
            </div>
          </form>
        </div>

        {/* Read-only metadata */}
        <div className="border-t pt-4 text-xs text-muted-foreground space-y-1">
          {profile.role && (
            <div>Role: <span className="font-medium text-foreground">{profile.role.name}</span></div>
          )}
          {profile.lastLoginAt && (
            <div>
              Last login:{' '}
              <span className="font-medium text-foreground">
                {new Date(profile.lastLoginAt).toLocaleString()}
              </span>
            </div>
          )}
          <div>
            Member since:{' '}
            <span className="font-medium text-foreground">
              {new Date(profile.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
