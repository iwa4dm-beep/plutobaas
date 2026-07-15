-- ============================================================
-- dubaiborkahouse (dbh_) — in-place migration bundle
-- Generated 2026-07-15T17:49:04.817Z
-- 28 tables, 1 enums, 8 functions
-- Prefix: dbh_
-- ============================================================

BEGIN;

-- ── 20260205022639_cd47f7aa-f104-469f-b18e-8557e9886967.sql ─────────────────────────────────────────
-- Create dbh_profiles table for user data
CREATE TABLE public.dbh_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  full_name TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on dbh_profiles
ALTER TABLE public.dbh_profiles ENABLE ROW LEVEL SECURITY;

-- Profiles RLS policies
CREATE POLICY "Users can view own profile"
  ON public.dbh_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON public.dbh_profiles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON public.dbh_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create dbh_products table
CREATE TABLE public.dbh_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  sale_price DECIMAL(10, 2),
  category TEXT NOT NULL,
  image_url TEXT,
  sizes TEXT[] DEFAULT '{}',
  colors TEXT[] DEFAULT '{}',
  stock INTEGER DEFAULT 0,
  featured BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on dbh_products (public read)
ALTER TABLE public.dbh_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Products are viewable by everyone"
  ON public.dbh_products FOR SELECT
  USING (true);

-- Create dbh_cart_items table
CREATE TABLE public.dbh_cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  product_id UUID REFERENCES public.dbh_products(id) ON DELETE CASCADE NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  size TEXT,
  color TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  UNIQUE(user_id, product_id, size, color)
);

-- Enable RLS on dbh_cart_items
ALTER TABLE public.dbh_cart_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own cart items"
  ON public.dbh_cart_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own cart items"
  ON public.dbh_cart_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own cart items"
  ON public.dbh_cart_items FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own cart items"
  ON public.dbh_cart_items FOR DELETE
  USING (auth.uid() = user_id);

-- Create dbh_orders table
CREATE TABLE public.dbh_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total DECIMAL(10, 2) NOT NULL,
  shipping_address TEXT NOT NULL,
  shipping_city TEXT NOT NULL,
  shipping_phone TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS on dbh_orders
ALTER TABLE public.dbh_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dbh_orders"
  ON public.dbh_orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own dbh_orders"
  ON public.dbh_orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create dbh_order_items table
CREATE TABLE public.dbh_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.dbh_orders(id) ON DELETE CASCADE NOT NULL,
  product_id UUID REFERENCES public.dbh_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  size TEXT,
  color TEXT
);

-- Enable RLS on dbh_order_items
ALTER TABLE public.dbh_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own order items"
  ON public.dbh_order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.dbh_orders
      WHERE dbh_orders.id = dbh_order_items.order_id
      AND dbh_orders.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own order items"
  ON public.dbh_order_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.dbh_orders
      WHERE dbh_orders.id = dbh_order_items.order_id
      AND dbh_orders.user_id = auth.uid()
    )
  );

-- Function to auto-create profile on signup
CREATE OR REPLACE FUNCTION public.dbh_handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.dbh_profiles (user_id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$;

-- Trigger for auto-creating profile
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.dbh_handle_new_user();

-- Function to update timestamps
CREATE OR REPLACE FUNCTION public.dbh_update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Triggers for updated_at
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.dbh_profiles
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_cart_items_updated_at
  BEFORE UPDATE ON public.dbh_cart_items
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.dbh_orders
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- ── 20260205030357_a910cb46-75bc-4dd0-bb33-fbd368dec4d5.sql ─────────────────────────────────────────
-- Create dbh_wishlist table
CREATE TABLE public.dbh_wishlist (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES public.dbh_products(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, product_id)
);

-- Enable Row Level Security
ALTER TABLE public.dbh_wishlist ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view own dbh_wishlist"
  ON public.dbh_wishlist FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can add to own dbh_wishlist"
  ON public.dbh_wishlist FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove from own dbh_wishlist"
  ON public.dbh_wishlist FOR DELETE
  USING (auth.uid() = user_id);

-- Create index for faster lookups
CREATE INDEX idx_wishlist_user_id ON public.dbh_wishlist(user_id);
CREATE INDEX idx_wishlist_product_id ON public.dbh_wishlist(product_id);

-- ── 20260205031204_4d49d519-ffea-4635-a385-ce058aa21f39.sql ─────────────────────────────────────────
-- Create dbh_app_role enum for role-based access control
CREATE TYPE public.dbh_app_role AS ENUM ('admin', 'moderator', 'user');

-- Create dbh_user_roles table for secure role management
CREATE TABLE public.dbh_user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role dbh_app_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Enable RLS on dbh_user_roles
ALTER TABLE public.dbh_user_roles ENABLE ROW LEVEL SECURITY;

-- Create security definer function to check roles (prevents RLS recursion)
CREATE OR REPLACE FUNCTION public.dbh_has_role(_user_id UUID, _role dbh_app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.dbh_user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- RLS policies for dbh_user_roles
CREATE POLICY "Users can view own roles"
ON public.dbh_user_roles
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all roles"
ON public.dbh_user_roles
FOR SELECT
USING (public.dbh_has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage roles"
ON public.dbh_user_roles
FOR ALL
USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Create dbh_product_reviews table
CREATE TABLE public.dbh_product_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.dbh_products(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title TEXT,
  comment TEXT,
  verified_purchase BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);

-- Enable RLS on dbh_product_reviews
ALTER TABLE public.dbh_product_reviews ENABLE ROW LEVEL SECURITY;

-- RLS policies for dbh_product_reviews
CREATE POLICY "Anyone can view reviews"
ON public.dbh_product_reviews
FOR SELECT
USING (true);

CREATE POLICY "Authenticated users can create reviews"
ON public.dbh_product_reviews
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own reviews"
ON public.dbh_product_reviews
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own reviews"
ON public.dbh_product_reviews
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all reviews"
ON public.dbh_product_reviews
FOR ALL
USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Add RLS policies for admin product management
CREATE POLICY "Admins can insert dbh_products"
ON public.dbh_products
FOR INSERT
WITH CHECK (public.dbh_has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update dbh_products"
ON public.dbh_products
FOR UPDATE
USING (public.dbh_has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete dbh_products"
ON public.dbh_products
FOR DELETE
USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Add policy for admins to view all dbh_orders
CREATE POLICY "Admins can view all dbh_orders"
ON public.dbh_orders
FOR SELECT
USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Add policy for admins to update order status
CREATE POLICY "Admins can update dbh_orders"
ON public.dbh_orders
FOR UPDATE
USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Add policy for admins to view all order items
CREATE POLICY "Admins can view all order items"
ON public.dbh_order_items
FOR SELECT
USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Create trigger for updated_at on reviews
CREATE TRIGGER update_product_reviews_updated_at
BEFORE UPDATE ON public.dbh_product_reviews
FOR EACH ROW
EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- Enable realtime for dbh_orders to get live updates in admin
ALTER PUBLICATION supabase_realtime ADD TABLE public.dbh_orders;

-- ── 20260205031555_f02d62d8-993f-440c-b98a-8ba9f69eebb4.sql ─────────────────────────────────────────
-- Allow admins to view all customer dbh_profiles
CREATE POLICY "Admins can view all dbh_profiles"
ON public.dbh_profiles
FOR SELECT
USING (public.dbh_has_role(auth.uid(), 'admin'));

-- ── 20260205032948_865322b1-65fb-4302-958a-0c68cdf169b7.sql ─────────────────────────────────────────
-- Create storage bucket for product images
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access to product images
CREATE POLICY "Product images are publicly accessible" 
ON storage.objects 
FOR SELECT 
USING (bucket_id = 'product-images');

-- Allow admins to upload product images
CREATE POLICY "Admins can upload product images" 
ON storage.objects 
FOR INSERT 
WITH CHECK (
  bucket_id = 'product-images' 
  AND public.dbh_has_role(auth.uid(), 'admin')
);

-- Allow admins to update product images
CREATE POLICY "Admins can update product images" 
ON storage.objects 
FOR UPDATE 
USING (
  bucket_id = 'product-images' 
  AND public.dbh_has_role(auth.uid(), 'admin')
);

-- Allow admins to delete product images
CREATE POLICY "Admins can delete product images" 
ON storage.objects 
FOR DELETE 
USING (
  bucket_id = 'product-images' 
  AND public.dbh_has_role(auth.uid(), 'admin')
);

-- ── 20260205180424_b9960382-7383-46f4-acd9-98f2556dcd5d.sql ─────────────────────────────────────────
-- Create dbh_product_variants table for per-size/color stock tracking
CREATE TABLE public.dbh_product_variants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.dbh_products(id) ON DELETE CASCADE,
  size TEXT,
  color TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  sku TEXT,
  price_adjustment NUMERIC DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(product_id, size, color)
);

-- Enable RLS
ALTER TABLE public.dbh_product_variants ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Variants are viewable by everyone" 
ON public.dbh_product_variants 
FOR SELECT 
USING (true);

CREATE POLICY "Admins can insert variants" 
ON public.dbh_product_variants 
FOR INSERT 
WITH CHECK (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

CREATE POLICY "Admins can update variants" 
ON public.dbh_product_variants 
FOR UPDATE 
USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

CREATE POLICY "Admins can delete variants" 
ON public.dbh_product_variants 
FOR DELETE 
USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Trigger for updated_at
CREATE TRIGGER update_product_variants_updated_at
BEFORE UPDATE ON public.dbh_product_variants
FOR EACH ROW
EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- Add guest checkout fields to dbh_orders table
ALTER TABLE public.dbh_orders 
ADD COLUMN IF NOT EXISTS guest_email TEXT,
ADD COLUMN IF NOT EXISTS guest_name TEXT,
ADD COLUMN IF NOT EXISTS is_guest BOOLEAN DEFAULT false;

-- Update dbh_orders RLS to allow guest dbh_orders
DROP POLICY IF EXISTS "Users can insert own dbh_orders" ON public.dbh_orders;
CREATE POLICY "Users can insert dbh_orders" 
ON public.dbh_orders 
FOR INSERT 
WITH CHECK (
  auth.uid() = user_id OR 
  (user_id IS NULL AND is_guest = true)
);

-- Allow guests to view their dbh_orders by email (handled in edge function)
DROP POLICY IF EXISTS "Users can view own dbh_orders" ON public.dbh_orders;
CREATE POLICY "Users can view own dbh_orders" 
ON public.dbh_orders 
FOR SELECT 
USING (auth.uid() = user_id OR user_id IS NULL);

-- ── 20260205183951_e7c13918-c1dd-46de-8a35-b4e7975b477d.sql ─────────────────────────────────────────
-- Create dbh_coupons table
CREATE TABLE public.dbh_coupons (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  discount_type TEXT NOT NULL DEFAULT 'percentage' CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC NOT NULL CHECK (discount_value > 0),
  minimum_order_amount NUMERIC DEFAULT 0,
  max_uses INTEGER,
  current_uses INTEGER NOT NULL DEFAULT 0,
  valid_from TIMESTAMP WITH TIME ZONE DEFAULT now(),
  valid_until TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add coupon tracking to dbh_orders
ALTER TABLE public.dbh_orders 
ADD COLUMN coupon_id UUID REFERENCES public.dbh_coupons(id),
ADD COLUMN discount_amount NUMERIC DEFAULT 0;

-- Enable RLS
ALTER TABLE public.dbh_coupons ENABLE ROW LEVEL SECURITY;

-- RLS Policies for dbh_coupons
CREATE POLICY "Everyone can view active dbh_coupons" 
ON public.dbh_coupons FOR SELECT 
USING (is_active = true);

CREATE POLICY "Admins can manage dbh_coupons" 
ON public.dbh_coupons FOR ALL 
USING (dbh_has_role(auth.uid(), 'admin'));

-- Trigger for updated_at
CREATE TRIGGER update_coupons_updated_at
BEFORE UPDATE ON public.dbh_coupons
FOR EACH ROW
EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- Insert some sample dbh_coupons
INSERT INTO public.dbh_coupons (code, description, discount_type, discount_value, minimum_order_amount, max_uses, valid_until) VALUES
('WELCOME10', 'নতুন কাস্টমারদের জন্য ১০% ছাড়', 'percentage', 10, 500, 100, now() + interval '1 year'),
('SAVE500', '৳৫০০ ছাড় - ৳৩০০০+ অর্ডারে', 'fixed', 500, 3000, 50, now() + interval '6 months'),
('EID25', 'ঈদ স্পেশাল ২৫% ছাড়', 'percentage', 25, 1000, 200, now() + interval '3 months');

-- ── 20260214122513_16fee4c3-9695-4b7c-93bb-0127b1b83231.sql ─────────────────────────────────────────

-- Add payment-related columns to dbh_orders table
ALTER TABLE public.dbh_orders 
ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'cod',
ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid',
ADD COLUMN IF NOT EXISTS transaction_id text,
ADD COLUMN IF NOT EXISTS advance_amount numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS due_amount numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS payment_phone text,
ADD COLUMN IF NOT EXISTS payment_verified boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS payment_verified_at timestamptz,
ADD COLUMN IF NOT EXISTS cod_collected boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS cod_collected_at timestamptz;


-- ── 20260214152644_c8e90e07-c6e9-4da0-8200-813ad066d83b.sql ─────────────────────────────────────────

-- Add tracking fields to dbh_orders
ALTER TABLE public.dbh_orders 
ADD COLUMN IF NOT EXISTS tracking_number text,
ADD COLUMN IF NOT EXISTS courier_name text,
ADD COLUMN IF NOT EXISTS estimated_delivery timestamp with time zone;

-- Create dbh_reward_points table
CREATE TABLE public.dbh_reward_points (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  points integer NOT NULL DEFAULT 0,
  type text NOT NULL, -- 'earned', 'redeemed', 'referral_bonus'
  description text,
  order_id uuid REFERENCES public.dbh_orders(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_reward_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own points" ON public.dbh_reward_points
FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "System can insert points" ON public.dbh_reward_points
FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can manage points" ON public.dbh_reward_points
FOR ALL USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Create dbh_referrals table
CREATE TABLE public.dbh_referrals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referral_code text NOT NULL UNIQUE,
  referred_user_id uuid REFERENCES auth.users(id),
  discount_percent numeric NOT NULL DEFAULT 10,
  is_used boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dbh_referrals" ON public.dbh_referrals
FOR SELECT USING (auth.uid() = referrer_id);

CREATE POLICY "Users can create own referral codes" ON public.dbh_referrals
FOR INSERT WITH CHECK (auth.uid() = referrer_id);

CREATE POLICY "Anyone can use a referral code" ON public.dbh_referrals
FOR UPDATE USING (is_used = false);

CREATE POLICY "Admins can manage dbh_referrals" ON public.dbh_referrals
FOR ALL USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Add referral_code to dbh_profiles for easy access
ALTER TABLE public.dbh_profiles
ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;

-- Add points_used to dbh_orders for redemption tracking
ALTER TABLE public.dbh_orders
ADD COLUMN IF NOT EXISTS points_used integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS points_discount numeric DEFAULT 0;

-- Function to generate referral code on profile creation
CREATE OR REPLACE FUNCTION public.dbh_generate_referral_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  NEW.referral_code := upper(substr(md5(random()::text), 1, 8));
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_referral_code
BEFORE INSERT ON public.dbh_profiles
FOR EACH ROW
WHEN (NEW.referral_code IS NULL)
EXECUTE FUNCTION public.dbh_generate_referral_code();

-- Generate referral codes for existing dbh_profiles
UPDATE public.dbh_profiles SET referral_code = upper(substr(md5(random()::text), 1, 8)) WHERE referral_code IS NULL;


-- ── 20260215192924_18d39056-9ede-45b8-9c8f-6aee7fa35cd2.sql ─────────────────────────────────────────

-- Fix 1: Orders SELECT policy - prevent authenticated users from seeing ALL guest dbh_orders
-- Drop the vulnerable policy
DROP POLICY IF EXISTS "Users can view own dbh_orders" ON public.dbh_orders;

-- Recreate: users can only see their own dbh_orders (user_id must match, no NULL user_id access)
CREATE POLICY "Users can view own dbh_orders"
ON public.dbh_orders
FOR SELECT
USING (auth.uid() = user_id);

-- Fix 2: Referrals UPDATE policy - restrict what can be updated
DROP POLICY IF EXISTS "Anyone can use a referral code" ON public.dbh_referrals;

-- Only allow setting referred_user_id to current user and marking as used, only if not already used
CREATE POLICY "Authenticated users can use a referral code"
ON public.dbh_referrals
FOR UPDATE
USING (is_used = false AND referred_user_id IS NULL)
WITH CHECK (is_used = true AND referred_user_id = auth.uid());


-- ── 20260215194934_db86b602-f7d2-4bde-8d33-4a9f151d4ba7.sql ─────────────────────────────────────────

-- Newsletter subscribers table for email campaigns
CREATE TABLE public.dbh_newsletter_subscribers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  subscribed boolean NOT NULL DEFAULT true,
  source text DEFAULT 'website',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_newsletter_subscribers ENABLE ROW LEVEL SECURITY;

-- Anyone can subscribe (insert)
CREATE POLICY "Anyone can subscribe" ON public.dbh_newsletter_subscribers
FOR INSERT WITH CHECK (true);

-- Only admins can view all subscribers
CREATE POLICY "Admins can view subscribers" ON public.dbh_newsletter_subscribers
FOR SELECT USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Only admins can manage subscribers
CREATE POLICY "Admins can manage subscribers" ON public.dbh_newsletter_subscribers
FOR ALL USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Email campaigns table
CREATE TABLE public.dbh_email_campaigns (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subject text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  sent_count integer DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  sent_at timestamp with time zone
);

ALTER TABLE public.dbh_email_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage campaigns" ON public.dbh_email_campaigns
FOR ALL USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Bundle deals table
CREATE TABLE public.dbh_bundle_deals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  discount_percent numeric NOT NULL DEFAULT 15,
  min_items integer NOT NULL DEFAULT 2,
  category text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_bundle_deals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view active bundles" ON public.dbh_bundle_deals
FOR SELECT USING (is_active = true);

CREATE POLICY "Admins can manage bundles" ON public.dbh_bundle_deals
FOR ALL USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));


-- ── 20260215200021_248fefd1-b283-489d-af51-022c76e5e668.sql ─────────────────────────────────────────

-- Create dbh_returns table for return/refund management
CREATE TABLE public.dbh_returns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.dbh_orders(id),
  user_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  refund_amount NUMERIC,
  admin_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_returns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dbh_returns"
ON public.dbh_returns FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can request dbh_returns"
ON public.dbh_returns FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can manage all dbh_returns"
ON public.dbh_returns FOR ALL
USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

CREATE TRIGGER update_returns_updated_at
BEFORE UPDATE ON public.dbh_returns
FOR EACH ROW
EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- Create dbh_site_content table for dynamic content editor
CREATE TABLE public.dbh_site_content (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  section_key TEXT NOT NULL UNIQUE,
  title TEXT,
  subtitle TEXT,
  content TEXT,
  image_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_by UUID
);

ALTER TABLE public.dbh_site_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view active content"
ON public.dbh_site_content FOR SELECT
USING (is_active = true);

CREATE POLICY "Admins can manage content"
ON public.dbh_site_content FOR ALL
USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

CREATE TRIGGER update_site_content_updated_at
BEFORE UPDATE ON public.dbh_site_content
FOR EACH ROW
EXECUTE FUNCTION public.dbh_update_updated_at_column();


-- ── 20260216072037_981452ab-4ef1-4d08-9023-4e08d0e8209b.sql ─────────────────────────────────────────

-- Product images gallery table
CREATE TABLE public.dbh_product_images (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.dbh_products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  alt_text TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.dbh_product_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view product images" ON public.dbh_product_images FOR SELECT USING (true);
CREATE POLICY "Admins can manage product images" ON public.dbh_product_images FOR ALL USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Add video_url to dbh_products
ALTER TABLE public.dbh_products ADD COLUMN IF NOT EXISTS video_url TEXT;

-- Price drop alerts table
CREATE TABLE public.dbh_price_drop_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES public.dbh_products(id) ON DELETE CASCADE,
  target_price NUMERIC,
  notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, product_id)
);
ALTER TABLE public.dbh_price_drop_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own alerts" ON public.dbh_price_drop_alerts FOR ALL USING (auth.uid() = user_id);

-- Customer segments table
CREATE TABLE public.dbh_customer_segments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  criteria JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.dbh_customer_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage segments" ON public.dbh_customer_segments FOR ALL USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Customer segment members
CREATE TABLE public.dbh_customer_segment_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  segment_id UUID NOT NULL REFERENCES public.dbh_customer_segments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(segment_id, user_id)
);
ALTER TABLE public.dbh_customer_segment_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage segment members" ON public.dbh_customer_segment_members FOR ALL USING (public.dbh_has_role(auth.uid(), 'admin'));


-- ── 20260216085208_976928c2-2d35-42fc-998b-75a32c726dac.sql ─────────────────────────────────────────

-- Add display_order column to dbh_site_content
ALTER TABLE public.dbh_site_content ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;

-- Delete existing dbh_site_content rows to re-seed with full homepage sections
DELETE FROM public.dbh_site_content;

-- Seed all homepage sections with proper order
INSERT INTO public.dbh_site_content (section_key, title, subtitle, content, is_active, display_order) VALUES
  ('announcement_bar', 'Announcement Bar', '🎉 ৳৫,০০০+ অর্ডারে ফ্রি শিপিং!', 'কোড ব্যবহার করুন: DUBAI10 — ১০% ছাড়!', true, 1),
  ('hero_banner', 'Hero Banner', 'Elegance Imported from Dubai', 'Discover premium abayas, borkas, and fabrics crafted with the finest materials from Dubai.', true, 2),
  ('flash_sale', 'Flash Sale Timer', '⚡ Flash Sale!', 'সীমিত সময়ের জন্য ৩০% পর্যন্ত ছাড়!', true, 3),
  ('featured_categories', 'Featured Categories', 'Browse By Category', 'Our Collections', true, 4),
  ('featured_products', 'Featured Products', 'Handpicked For You', 'Featured Products', true, 5),
  ('special_offer', 'Special Offer', 'Limited Time Offer', 'Up to 40% Off on Premium Kaftans', true, 6),
  ('dbh_bundle_deals', 'Bundle Deals', 'Bundle Offers', 'একসাথে কিনলে বেশি সেভ!', true, 7),
  ('about_section', 'About Us', 'About Us', 'Where Dubai Luxury Meets Bangladeshi Elegance', true, 8),
  ('why_choose_us', 'Why Choose Us', 'Why Choose Us', 'The Dubai Borka House Difference', true, 9),
  ('testimonials', 'Testimonials', 'Customer Love', 'What Our Customers Say', true, 10),
  ('instagram_feed', 'Instagram Feed', 'Follow Us On Instagram', '@DubaiBorkaHouse', true, 11),
  ('newsletter', 'Newsletter', 'Get 15% Off Your First Order', 'Subscribe to our newsletter for exclusive offers.', true, 12);


-- ── 20260225075722_5b57db48-cfd7-4f87-80a9-5558332a6baa.sql ─────────────────────────────────────────

-- Create dbh_blog_posts table
CREATE TABLE public.dbh_blog_posts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT,
  content TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  image_url TEXT,
  author_name TEXT DEFAULT 'Dubai Borka House',
  is_published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMP WITH TIME ZONE,
  read_time TEXT DEFAULT '৫ মিনিট',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.dbh_blog_posts ENABLE ROW LEVEL SECURITY;

-- Everyone can view published posts
CREATE POLICY "Anyone can view published blog posts"
ON public.dbh_blog_posts
FOR SELECT
USING (is_published = true);

-- Admins can manage all posts
CREATE POLICY "Admins can manage blog posts"
ON public.dbh_blog_posts
FOR ALL
USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Trigger for updated_at
CREATE TRIGGER update_blog_posts_updated_at
BEFORE UPDATE ON public.dbh_blog_posts
FOR EACH ROW
EXECUTE FUNCTION public.dbh_update_updated_at_column();


-- ── 20260225084249_f46c1562-7b48-4c71-8335-c38218a1e7c8.sql ─────────────────────────────────────────

-- Function to auto-deduct stock when order items are inserted
CREATE OR REPLACE FUNCTION public.dbh_deduct_stock_on_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Deduct from main dbh_products table
  UPDATE public.dbh_products
  SET stock = GREATEST(COALESCE(stock, 0) - NEW.quantity, 0)
  WHERE id = NEW.product_id;

  -- Deduct from dbh_product_variants if size/color specified
  IF NEW.size IS NOT NULL OR NEW.color IS NOT NULL THEN
    UPDATE public.dbh_product_variants
    SET stock = GREATEST(stock - NEW.quantity, 0)
    WHERE product_id = NEW.product_id
      AND (NEW.size IS NULL OR size = NEW.size)
      AND (NEW.color IS NULL OR color = NEW.color);
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger on dbh_order_items insert
CREATE TRIGGER trigger_deduct_stock_on_order
AFTER INSERT ON public.dbh_order_items
FOR EACH ROW
EXECUTE FUNCTION public.dbh_deduct_stock_on_order();

-- Function to restore stock on order cancellation
CREATE OR REPLACE FUNCTION public.dbh_restore_stock_on_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.status != 'cancelled' AND NEW.status = 'cancelled' THEN
    -- Restore stock for each order item
    UPDATE public.dbh_products p
    SET stock = COALESCE(p.stock, 0) + oi.quantity
    FROM public.dbh_order_items oi
    WHERE oi.order_id = NEW.id
      AND p.id = oi.product_id;

    -- Restore variant stock
    UPDATE public.dbh_product_variants pv
    SET stock = pv.stock + oi.quantity
    FROM public.dbh_order_items oi
    WHERE oi.order_id = NEW.id
      AND pv.product_id = oi.product_id
      AND (oi.size IS NULL OR pv.size = oi.size)
      AND (oi.color IS NULL OR pv.color = oi.color);
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger on order status change to cancelled
CREATE TRIGGER trigger_restore_stock_on_cancel
AFTER UPDATE OF status ON public.dbh_orders
FOR EACH ROW
EXECUTE FUNCTION public.dbh_restore_stock_on_cancel();


-- ── 20260225091141_ff27aa8e-c1c1-42d5-be8b-79ab1c7ca13f.sql ─────────────────────────────────────────

-- 1. Delivery Zones table
CREATE TABLE public.dbh_delivery_zones (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  zone_name TEXT NOT NULL,
  city TEXT NOT NULL,
  areas TEXT[] DEFAULT '{}',
  shipping_charge NUMERIC NOT NULL DEFAULT 0,
  estimated_days INTEGER DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_delivery_zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage delivery zones" ON public.dbh_delivery_zones
  FOR ALL USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

CREATE POLICY "Everyone can view active delivery zones" ON public.dbh_delivery_zones
  FOR SELECT USING (is_active = true);

CREATE TRIGGER update_delivery_zones_updated_at
  BEFORE UPDATE ON public.dbh_delivery_zones
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- 2. Add slug column to dbh_products
ALTER TABLE public.dbh_products ADD COLUMN IF NOT EXISTS slug TEXT;

-- Generate slugs for existing dbh_products
UPDATE public.dbh_products 
SET slug = lower(regexp_replace(regexp_replace(name, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g')) || '-' || substr(id::text, 1, 8)
WHERE slug IS NULL;

-- Create unique index on slug
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON public.dbh_products(slug);

-- 3. Allow customers to cancel their own pending dbh_orders
CREATE POLICY "Users can cancel own pending dbh_orders" ON public.dbh_orders
  FOR UPDATE USING (
    auth.uid() = user_id 
    AND status = 'pending'
  )
  WITH CHECK (
    status = 'cancelled'
  );


-- ── 20260225091830_1f6d2c5b-269a-4b5c-8b3d-7152da927151.sql ─────────────────────────────────────────

-- Auto-generate slug on product insert/update
CREATE OR REPLACE FUNCTION public.dbh_generate_product_slug()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  base_slug TEXT;
  final_slug TEXT;
  counter INTEGER := 0;
BEGIN
  -- Generate slug from name if slug is null or empty
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base_slug := lower(regexp_replace(regexp_replace(NEW.name, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));
    final_slug := base_slug;
    
    -- Handle uniqueness
    LOOP
      IF NOT EXISTS (SELECT 1 FROM public.dbh_products WHERE slug = final_slug AND id != NEW.id) THEN
        EXIT;
      END IF;
      counter := counter + 1;
      final_slug := base_slug || '-' || counter;
    END LOOP;
    
    NEW.slug := final_slug;
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_generate_product_slug
  BEFORE INSERT OR UPDATE ON public.dbh_products
  FOR EACH ROW
  EXECUTE FUNCTION public.dbh_generate_product_slug();


-- ── 20260225111536_f17cf5a2-f9e3-4bac-a817-00e59d2701cd.sql ─────────────────────────────────────────
ALTER TABLE public.dbh_product_reviews DROP CONSTRAINT IF EXISTS product_reviews_product_id_user_id_key;

-- ── 20260227083101_f1872216-098d-4ae0-a502-8530a5d1c7d6.sql ─────────────────────────────────────────
-- Add image_url column to dbh_product_variants for color-specific images
ALTER TABLE public.dbh_product_variants ADD COLUMN IF NOT EXISTS image_url text;

-- ── 20260227144051_79579d84-9140-4dd8-8a10-0218fc5606f8.sql ─────────────────────────────────────────

-- Use DROP IF EXISTS + CREATE to avoid conflicts

-- dbh_handle_new_user trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.dbh_handle_new_user();

-- dbh_generate_referral_code
DROP TRIGGER IF EXISTS generate_referral_code_trigger ON public.dbh_profiles;
CREATE TRIGGER generate_referral_code_trigger
  BEFORE INSERT ON public.dbh_profiles
  FOR EACH ROW
  WHEN (NEW.referral_code IS NULL)
  EXECUTE FUNCTION public.dbh_generate_referral_code();

-- dbh_generate_product_slug
DROP TRIGGER IF EXISTS generate_product_slug_trigger ON public.dbh_products;
CREATE TRIGGER generate_product_slug_trigger
  BEFORE INSERT OR UPDATE ON public.dbh_products
  FOR EACH ROW EXECUTE FUNCTION public.dbh_generate_product_slug();

-- dbh_deduct_stock_on_order
DROP TRIGGER IF EXISTS deduct_stock_on_order_trigger ON public.dbh_order_items;
CREATE TRIGGER deduct_stock_on_order_trigger
  AFTER INSERT ON public.dbh_order_items
  FOR EACH ROW EXECUTE FUNCTION public.dbh_deduct_stock_on_order();

-- dbh_restore_stock_on_cancel
DROP TRIGGER IF EXISTS restore_stock_on_cancel_trigger ON public.dbh_orders;
CREATE TRIGGER restore_stock_on_cancel_trigger
  BEFORE UPDATE ON public.dbh_orders
  FOR EACH ROW EXECUTE FUNCTION public.dbh_restore_stock_on_cancel();

-- Updated_at triggers
DROP TRIGGER IF EXISTS update_orders_updated_at ON public.dbh_orders;
CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.dbh_orders
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.dbh_profiles;
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.dbh_profiles
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_coupons_updated_at ON public.dbh_coupons;
CREATE TRIGGER update_coupons_updated_at
  BEFORE UPDATE ON public.dbh_coupons
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_product_variants_updated_at ON public.dbh_product_variants;
CREATE TRIGGER update_product_variants_updated_at
  BEFORE UPDATE ON public.dbh_product_variants
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_product_reviews_updated_at ON public.dbh_product_reviews;
CREATE TRIGGER update_product_reviews_updated_at
  BEFORE UPDATE ON public.dbh_product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_returns_updated_at ON public.dbh_returns;
CREATE TRIGGER update_returns_updated_at
  BEFORE UPDATE ON public.dbh_returns
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_site_content_updated_at ON public.dbh_site_content;
CREATE TRIGGER update_site_content_updated_at
  BEFORE UPDATE ON public.dbh_site_content
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_delivery_zones_updated_at ON public.dbh_delivery_zones;
CREATE TRIGGER update_delivery_zones_updated_at
  BEFORE UPDATE ON public.dbh_delivery_zones
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_customer_segments_updated_at ON public.dbh_customer_segments;
CREATE TRIGGER update_customer_segments_updated_at
  BEFORE UPDATE ON public.dbh_customer_segments
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

DROP TRIGGER IF EXISTS update_cart_items_updated_at ON public.dbh_cart_items;
CREATE TRIGGER update_cart_items_updated_at
  BEFORE UPDATE ON public.dbh_cart_items
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();


-- ── 20260301183545_40f25556-14e9-4c83-8bc5-205fdacbc1b6.sql ─────────────────────────────────────────

-- Create dbh_chat_histories table to store customer chat conversations
CREATE TABLE public.dbh_chat_histories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES public.dbh_orders(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  products_discussed JSONB DEFAULT '[]'::jsonb,
  order_total NUMERIC,
  order_status TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.dbh_chat_histories ENABLE ROW LEVEL SECURITY;

-- Only admins can view chat histories
CREATE POLICY "Admins can manage chat histories"
  ON public.dbh_chat_histories FOR ALL
  USING (public.dbh_has_role(auth.uid(), 'admin'));

-- Allow anonymous inserts from edge function (service role will be used)
CREATE POLICY "Service can insert chat histories"
  ON public.dbh_chat_histories FOR INSERT
  WITH CHECK (true);

-- Index for faster lookups
CREATE INDEX idx_chat_histories_order_id ON public.dbh_chat_histories(order_id);
CREATE INDEX idx_chat_histories_created_at ON public.dbh_chat_histories(created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER update_chat_histories_updated_at
  BEFORE UPDATE ON public.dbh_chat_histories
  FOR EACH ROW
  EXECUTE FUNCTION public.dbh_update_updated_at_column();


-- ── 20260301183559_a730833d-ea6d-4b25-b13f-9b7de12e095b.sql ─────────────────────────────────────────

-- Drop the overly permissive insert policy and replace with a more restrictive one
DROP POLICY "Service can insert chat histories" ON public.dbh_chat_histories;

-- Only service role (edge functions) will insert, so no anon insert policy needed
-- The admin ALL policy already covers admin access


-- ── 20260302093058_cdb34e24-381a-4f0a-ad29-c97df32c48d4.sql ─────────────────────────────────────────

-- Add material column to dbh_products
ALTER TABLE public.dbh_products ADD COLUMN IF NOT EXISTS material text DEFAULT NULL;

-- Create dbh_back_in_stock_alerts table
CREATE TABLE IF NOT EXISTS public.dbh_back_in_stock_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES public.dbh_products(id) ON DELETE CASCADE,
  email text NOT NULL,
  notified boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.dbh_back_in_stock_alerts ENABLE ROW LEVEL SECURITY;

-- Anyone can subscribe to alerts (no auth required)
CREATE POLICY "Anyone can create back in stock alerts"
  ON public.dbh_back_in_stock_alerts FOR INSERT
  WITH CHECK (true);

-- Admins can manage all alerts
CREATE POLICY "Admins can manage back in stock alerts"
  ON public.dbh_back_in_stock_alerts FOR ALL
  USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

-- Create index for efficient lookup
CREATE INDEX idx_back_in_stock_product ON public.dbh_back_in_stock_alerts(product_id, notified);

-- Create trigger to send email when product is restocked
CREATE OR REPLACE FUNCTION public.dbh_notify_back_in_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- When stock goes from 0 to > 0, mark alerts for notification
  IF (OLD.stock IS NULL OR OLD.stock <= 0) AND NEW.stock > 0 THEN
    UPDATE public.dbh_back_in_stock_alerts
    SET notified = true
    WHERE product_id = NEW.id AND notified = false;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_back_in_stock
AFTER UPDATE OF stock ON public.dbh_products
FOR EACH ROW
EXECUTE FUNCTION public.dbh_notify_back_in_stock();


-- ── 20260302093834_d17993e5-0bfa-4733-91ab-9824a9c3ea97.sql ─────────────────────────────────────────

-- Address Book table for multiple saved addresses
CREATE TABLE public.dbh_saved_addresses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  label TEXT NOT NULL DEFAULT 'Home',
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  district TEXT,
  postal_code TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_saved_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own addresses"
ON public.dbh_saved_addresses FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_saved_addresses_updated_at
BEFORE UPDATE ON public.dbh_saved_addresses
FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- Staff permissions table for granular role-based access
CREATE TABLE public.dbh_staff_permissions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  permission TEXT NOT NULL,
  granted_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, permission)
);

ALTER TABLE public.dbh_staff_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage permissions"
ON public.dbh_staff_permissions FOR ALL
USING (public.dbh_has_role(auth.uid(), 'admin'))
WITH CHECK (public.dbh_has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view own permissions"
ON public.dbh_staff_permissions FOR SELECT
USING (auth.uid() = user_id);


-- ── 20260303103558_01b61802-8347-46f1-b872-0b573c925fc9.sql ─────────────────────────────────────────

-- Drop and recreate all triggers to ensure consistency

-- Drop existing triggers first (safe - won't error if they don't exist)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS generate_slug_before_insert ON public.dbh_products;
DROP TRIGGER IF EXISTS generate_slug_before_update ON public.dbh_products;
DROP TRIGGER IF EXISTS generate_referral_code_trigger ON public.dbh_profiles;
DROP TRIGGER IF EXISTS deduct_stock_trigger ON public.dbh_order_items;
DROP TRIGGER IF EXISTS restore_stock_on_cancel_trigger ON public.dbh_orders;
DROP TRIGGER IF EXISTS notify_back_in_stock_trigger ON public.dbh_products;
DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.dbh_profiles;
DROP TRIGGER IF EXISTS update_orders_updated_at ON public.dbh_orders;
DROP TRIGGER IF EXISTS update_cart_items_updated_at ON public.dbh_cart_items;
DROP TRIGGER IF EXISTS update_coupons_updated_at ON public.dbh_coupons;
DROP TRIGGER IF EXISTS update_delivery_zones_updated_at ON public.dbh_delivery_zones;
DROP TRIGGER IF EXISTS update_site_content_updated_at ON public.dbh_site_content;
DROP TRIGGER IF EXISTS update_product_variants_updated_at ON public.dbh_product_variants;
DROP TRIGGER IF EXISTS update_saved_addresses_updated_at ON public.dbh_saved_addresses;
DROP TRIGGER IF EXISTS update_returns_updated_at ON public.dbh_returns;
DROP TRIGGER IF EXISTS update_customer_segments_updated_at ON public.dbh_customer_segments;
DROP TRIGGER IF EXISTS update_product_reviews_updated_at ON public.dbh_product_reviews;
DROP TRIGGER IF EXISTS update_chat_histories_updated_at ON public.dbh_chat_histories;

-- Recreate all triggers
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.dbh_handle_new_user();

CREATE TRIGGER generate_slug_before_insert
  BEFORE INSERT ON public.dbh_products
  FOR EACH ROW EXECUTE FUNCTION public.dbh_generate_product_slug();

CREATE TRIGGER generate_slug_before_update
  BEFORE UPDATE ON public.dbh_products
  FOR EACH ROW EXECUTE FUNCTION public.dbh_generate_product_slug();

CREATE TRIGGER generate_referral_code_trigger
  BEFORE INSERT ON public.dbh_profiles
  FOR EACH ROW EXECUTE FUNCTION public.dbh_generate_referral_code();

CREATE TRIGGER deduct_stock_trigger
  AFTER INSERT ON public.dbh_order_items
  FOR EACH ROW EXECUTE FUNCTION public.dbh_deduct_stock_on_order();

CREATE TRIGGER restore_stock_on_cancel_trigger
  AFTER UPDATE ON public.dbh_orders
  FOR EACH ROW EXECUTE FUNCTION public.dbh_restore_stock_on_cancel();

CREATE TRIGGER notify_back_in_stock_trigger
  AFTER UPDATE ON public.dbh_products
  FOR EACH ROW EXECUTE FUNCTION public.dbh_notify_back_in_stock();

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.dbh_profiles
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.dbh_orders
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_cart_items_updated_at
  BEFORE UPDATE ON public.dbh_cart_items
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_coupons_updated_at
  BEFORE UPDATE ON public.dbh_coupons
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_delivery_zones_updated_at
  BEFORE UPDATE ON public.dbh_delivery_zones
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_site_content_updated_at
  BEFORE UPDATE ON public.dbh_site_content
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_product_variants_updated_at
  BEFORE UPDATE ON public.dbh_product_variants
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_saved_addresses_updated_at
  BEFORE UPDATE ON public.dbh_saved_addresses
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_returns_updated_at
  BEFORE UPDATE ON public.dbh_returns
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_customer_segments_updated_at
  BEFORE UPDATE ON public.dbh_customer_segments
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_product_reviews_updated_at
  BEFORE UPDATE ON public.dbh_product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

CREATE TRIGGER update_chat_histories_updated_at
  BEFORE UPDATE ON public.dbh_chat_histories
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();


-- ── 20260303181206_3f6bc460-eb0b-4267-a805-87ed1ecef0c9.sql ─────────────────────────────────────────

-- Remove duplicate triggers on dbh_order_items (keep only one)
DROP TRIGGER IF EXISTS trigger_deduct_stock_on_order ON public.dbh_order_items;
DROP TRIGGER IF EXISTS deduct_stock_on_order_trigger ON public.dbh_order_items;
-- Keep deduct_stock_trigger

-- Remove duplicate triggers on dbh_orders
DROP TRIGGER IF EXISTS trigger_restore_stock_on_cancel ON public.dbh_orders;
-- Keep restore_stock_on_cancel_trigger

-- Remove duplicate triggers on dbh_products
DROP TRIGGER IF EXISTS notify_back_in_stock_trigger ON public.dbh_products;
DROP TRIGGER IF EXISTS generate_slug_before_update ON public.dbh_products;
DROP TRIGGER IF EXISTS generate_slug_before_insert ON public.dbh_products;
DROP TRIGGER IF EXISTS generate_product_slug_trigger ON public.dbh_products;
-- Keep trigger_back_in_stock and trigger_generate_product_slug

-- Remove duplicate trigger on dbh_profiles
DROP TRIGGER IF EXISTS set_referral_code ON public.dbh_profiles;
-- Keep generate_referral_code_trigger

-- Add missing dbh_handle_new_user trigger on auth.users
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.dbh_handle_new_user();


-- ── 20260303181801_49136210-1bf7-476a-93dc-17d0a0976572.sql ─────────────────────────────────────────

-- Create dbh_categories table for dynamic category management
CREATE TABLE public.dbh_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_bn text,
  slug text UNIQUE,
  description text,
  description_bn text,
  image_url text,
  item_count text DEFAULT '0+ Items',
  display_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dbh_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone can view active dbh_categories" ON public.dbh_categories
  FOR SELECT USING (is_active = true);

CREATE POLICY "Admins can manage dbh_categories" ON public.dbh_categories
  FOR ALL USING (dbh_has_role(auth.uid(), 'admin'::dbh_app_role));

CREATE TRIGGER update_categories_updated_at
  BEFORE UPDATE ON public.dbh_categories
  FOR EACH ROW EXECUTE FUNCTION public.dbh_update_updated_at_column();

-- Insert default dbh_categories
INSERT INTO public.dbh_categories (name, name_bn, slug, description, description_bn, image_url, item_count, display_order) VALUES
('borka', 'বোরকা', 'borka', 'Premium borka collection from Dubai', 'দুবাই থেকে আমদানিকৃত প্রিমিয়াম বোরকা কালেকশন', '/dbh_products/product-borka-embroidery.jpg', '50+ Items', 1),
('abaya', 'আবায়া', 'abaya', 'Elegant Dubai-style abayas with intricate embroidery', 'মার্জিত দুবাই স্টাইল আবায়া এমব্রয়ডারিসহ', '/dbh_products/product-abaya-black.jpg', '40+ Items', 2),
('hijab', 'হিজাব', 'hijab', 'Premium silk and cotton hijabs in stunning colors', 'প্রিমিয়াম সিল্ক ও কটন হিজাব সুন্দর রঙে', '/dbh_products/product-hijab-chiffon.jpg', '200+ Items', 3),
('kaftan', 'কাফতান', 'kaftan', 'Ornate Arabian kaftans for special occasions', 'বিশেষ অনুষ্ঠানের জন্য আরবীয় কাফতান', '/dbh_products/product-kaftan-gold.jpg', '30+ Items', 4),
('scarf', 'স্কার্ফ', 'scarf', 'Beautiful printed scarves in various styles', 'বিভিন্ন স্টাইলের সুন্দর প্রিন্ট স্কার্ফ', '/dbh_products/product-scarf-floral.jpg', '80+ Items', 5),
('fabric', 'ফেব্রিক', 'fabric', 'Luxurious imported fabrics for custom tailoring', 'কাস্টম টেইলরিংয়ের জন্য আমদানিকৃত ফেব্রিক', '/dbh_products/product-fabric-nida.jpg', '100+ Items', 6);



-- ── Data-API GRANTs (Lovable Cloud requirement) ──────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_profiles TO authenticated;
GRANT ALL ON public.dbh_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_products TO authenticated;
GRANT ALL ON public.dbh_products TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_cart_items TO authenticated;
GRANT ALL ON public.dbh_cart_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_orders TO authenticated;
GRANT ALL ON public.dbh_orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_order_items TO authenticated;
GRANT ALL ON public.dbh_order_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_wishlist TO authenticated;
GRANT ALL ON public.dbh_wishlist TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_user_roles TO authenticated;
GRANT ALL ON public.dbh_user_roles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_product_reviews TO authenticated;
GRANT ALL ON public.dbh_product_reviews TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_product_variants TO authenticated;
GRANT ALL ON public.dbh_product_variants TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_coupons TO authenticated;
GRANT ALL ON public.dbh_coupons TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_reward_points TO authenticated;
GRANT ALL ON public.dbh_reward_points TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_referrals TO authenticated;
GRANT ALL ON public.dbh_referrals TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_newsletter_subscribers TO authenticated;
GRANT ALL ON public.dbh_newsletter_subscribers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_email_campaigns TO authenticated;
GRANT ALL ON public.dbh_email_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_bundle_deals TO authenticated;
GRANT ALL ON public.dbh_bundle_deals TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_returns TO authenticated;
GRANT ALL ON public.dbh_returns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_site_content TO authenticated;
GRANT ALL ON public.dbh_site_content TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_product_images TO authenticated;
GRANT ALL ON public.dbh_product_images TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_price_drop_alerts TO authenticated;
GRANT ALL ON public.dbh_price_drop_alerts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_customer_segments TO authenticated;
GRANT ALL ON public.dbh_customer_segments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_customer_segment_members TO authenticated;
GRANT ALL ON public.dbh_customer_segment_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_blog_posts TO authenticated;
GRANT ALL ON public.dbh_blog_posts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_delivery_zones TO authenticated;
GRANT ALL ON public.dbh_delivery_zones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_chat_histories TO authenticated;
GRANT ALL ON public.dbh_chat_histories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_back_in_stock_alerts TO authenticated;
GRANT ALL ON public.dbh_back_in_stock_alerts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_saved_addresses TO authenticated;
GRANT ALL ON public.dbh_saved_addresses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_staff_permissions TO authenticated;
GRANT ALL ON public.dbh_staff_permissions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dbh_categories TO authenticated;
GRANT ALL ON public.dbh_categories TO service_role;


-- Public read (anon) — catalog tables only
GRANT SELECT ON public.dbh_products TO anon;
GRANT SELECT ON public.dbh_categories TO anon;
GRANT SELECT ON public.dbh_product_variants TO anon;
GRANT SELECT ON public.dbh_product_images TO anon;
GRANT SELECT ON public.dbh_product_reviews TO anon;
GRANT SELECT ON public.dbh_blog_posts TO anon;
GRANT SELECT ON public.dbh_bundle_deals TO anon;
GRANT SELECT ON public.dbh_site_content TO anon;
GRANT SELECT ON public.dbh_delivery_zones TO anon;
GRANT SELECT ON public.dbh_coupons TO anon;
GRANT SELECT ON public.dbh_newsletter_subscribers TO anon;

COMMIT;
