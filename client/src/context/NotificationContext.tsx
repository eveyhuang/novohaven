import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
  executionId?: number;
  recipeName?: string;
  autoClose?: boolean;
  duration?: number;
}

interface BackgroundExecution {
  id: number;
  recipeName: string;
  status: string;
  startedAt: Date;
}

interface NotificationContextType {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id'>) => string;
  removeNotification: (id: string) => void;
  clearAll: () => void;
  // Background execution tracking
  backgroundExecutions: BackgroundExecution[];
  trackExecution: (executionId: number, recipeName: string) => void;
  stopTracking: (executionId: number) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [backgroundExecutions, setBackgroundExecutions] = useState<BackgroundExecution[]>([]);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const addNotification = useCallback((notification: Omit<Notification, 'id'>) => {
    const id = `notification-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newNotification: Notification = {
      ...notification,
      id,
      autoClose: notification.autoClose ?? true,
      duration: notification.duration ?? 5000,
    };

    setNotifications(prev => [...prev, newNotification]);

    // Auto-close after duration
    if (newNotification.autoClose) {
      setTimeout(() => {
        removeNotification(id);
      }, newNotification.duration);
    }

    return id;
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const trackExecution = useCallback((executionId: number, recipeName: string) => {
    setBackgroundExecutions(prev => {
      // Don't add if already tracking
      if (prev.some(e => e.id === executionId)) {
        return prev;
      }
      return [...prev, {
        id: executionId,
        recipeName,
        status: 'running',
        startedAt: new Date(),
      }];
    });
  }, []);

  const stopTracking = useCallback((executionId: number) => {
    setBackgroundExecutions(prev => prev.filter(e => e.id !== executionId));
  }, []);

  // Poll for execution status changes
  useEffect(() => {
    if (backgroundExecutions.length === 0) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return;
    }

    const pollExecutions = async () => {
      for (const exec of backgroundExecutions) {
        try {
          const status = await api.getExecutionStatus(exec.id);

          // Check if status changed to completed, failed, or paused (awaiting review)
          if (status.status === 'completed') {
            addNotification({
              type: 'success',
              title: 'Workflow Completed',
              message: `"${exec.recipeName}" has finished successfully.`,
              executionId: exec.id,
              recipeName: exec.recipeName,
              autoClose: false,
            });
            stopTracking(exec.id);
          } else if (status.status === 'failed') {
            addNotification({
              type: 'error',
              title: 'Workflow Failed',
              message: `"${exec.recipeName}" encountered an error.`,
              executionId: exec.id,
              recipeName: exec.recipeName,
              autoClose: false,
            });
            stopTracking(exec.id);
          } else if (status.status === 'paused') {
            // Execution is paused - typically means a step is awaiting review
            addNotification({
              type: 'info',
              title: 'Review Required',
              message: `"${exec.recipeName}" is waiting for your review.`,
              executionId: exec.id,
              recipeName: exec.recipeName,
              autoClose: false,
            });
            stopTracking(exec.id);
          }
        } catch (error) {
          console.error(`Error polling execution ${exec.id}:`, error);
        }
      }
    };

    // Initial poll
    pollExecutions();

    // Set up interval polling (every 3 seconds)
    pollingIntervalRef.current = setInterval(pollExecutions, 3000);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [backgroundExecutions, addNotification, stopTracking]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        addNotification,
        removeNotification,
        clearAll,
        backgroundExecutions,
        trackExecution,
        stopTracking,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
}
