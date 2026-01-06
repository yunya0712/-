
// Fix: Added React import to provide access to the React namespace for React.ReactNode
import React from 'react';

export interface Tip {
  id: string;
  title: string;
  content: string;
  icon: string;
}

export interface SectionProps {
  children: React.ReactNode;
  className?: string;
  id?: string;
}